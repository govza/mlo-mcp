import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudState } from "./state.js";
import { BindingStore, type ProfileBinding } from "./binding.js";
import { BootstrapController } from "./bootstrap.js";
import { normalizeDataFileUid, PartitionRegistry, type PartitionHandle, type PartitionLifecycle } from "./partition.js";
import type { UpstreamContext, VendorContact } from "./upstream.js";
import { log } from "../log.js";

/**
 * Which authority answers one SOAP sync operation. All three operations of a
 * profile session must resolve to the SAME authority (the vendor protocol's
 * session is one logical unit), so decisions are pinned per `sessionID`.
 */
export type SoapAuthority =
  | { kind: "local" }
  | { kind: "upstream"; context: UpstreamContext }
  | { kind: "reject"; message: string };

const SESSION_PIN_TTL_MS = 10 * 60 * 1000;

/**
 * Routes every cloud-state access — SOAP, /v1, MCP tools, status — to the
 * per-`dataFileUID` partition it belongs to, under one private state root
 * outside any checkout. A profile's MODE (vendor-proxy "upstream" vs
 * replacement-server "local") lives in its persisted binding, chosen at
 * `cloud_bootstrap` time — it is not server configuration.
 */
export interface CloudGatewayOptions {
  stateRoot: string;
}

export class CloudGateway {
  readonly registry: PartitionRegistry;
  readonly bindings: BindingStore;
  readonly bootstrap: BootstrapController;
  readonly stateRoot: string;
  private unboundState?: CloudState;
  private rootPrepared = false;
  private sessionAuthorities = new Map<string, { authority: SoapAuthority; expires: number }>();
  /**
   * Vendor-client contacts per normalized dataFileUID, captured from the
   * profile's own proxied sync traffic. STRICTLY in-memory: never persisted,
   * never logged — they let the endpoint act as one more sync client of the
   * user's own vendor account (pull-bootstrap and MCP write sessions).
   */
  private vendorContacts = new Map<string, VendorContact>();

  constructor(options: CloudGatewayOptions) {
    this.stateRoot = options.stateRoot;
    this.registry = new PartitionRegistry(options.stateRoot);
    this.bindings = new BindingStore(options.stateRoot);
    this.bootstrap = new BootstrapController(options.stateRoot);
  }

  /** Where the sync observer writes its structural summaries. */
  observerDir(): string {
    return this.stateRoot;
  }

  /**
   * Placeholder log for callers that address no specific partition, so
   * `/v1/status` (the attach probe) and tool contexts keep a stable shape
   * before a profile is bound. Never routed to by SOAP.
   */
  defaultState(): CloudState {
    this.unboundState ??= new CloudState(path.join(this.stateRoot, "unbound"));
    return this.unboundState;
  }

  /**
   * Decide the authority for one SOAP sync operation from its parsed fields.
   * Local termination answers local-mode partitions (and malformed requests,
   * which it fails properly); upstream-bound and unknown windowless
   * dataFileUIDs belong to the vendor. The decision is pinned per sessionID
   * so a binding change can never switch authorities mid-session.
   */
  async decideAuthority(fields: Record<string, unknown>): Promise<SoapAuthority> {
    const sessionId = typeof fields.sessionID === "string" && fields.sessionID.length ? fields.sessionID : undefined;
    const now = Date.now();
    if (sessionId) {
      const pinned = this.sessionAuthorities.get(sessionId);
      if (pinned && pinned.expires > now) {
        pinned.expires = now + SESSION_PIN_TTL_MS;
        return pinned.authority;
      }
      this.sessionAuthorities.delete(sessionId);
    }
    const authority = await this.computeAuthority(fields);
    if (sessionId) {
      for (const [key, value] of this.sessionAuthorities) if (value.expires <= now) this.sessionAuthorities.delete(key);
      this.sessionAuthorities.set(sessionId, { authority, expires: now + SESSION_PIN_TTL_MS });
    }
    return authority;
  }

  private async computeAuthority(fields: Record<string, unknown>): Promise<SoapAuthority> {
    const rawUid = typeof fields.dataFileUID === "string" && fields.dataFileUID.length ? fields.dataFileUID : undefined;
    if (!rawUid) return { kind: "local" }; // local handling reports the missing UID
    let uid: string;
    try {
      uid = normalizeDataFileUid(rawUid);
    } catch {
      return { kind: "local" }; // local handling reports the invalid UID
    }
    await this.prepareRoot();
    const binding = await this.bindings.forUid(uid);
    if (binding) {
      if (binding.mode === "local") return { kind: "local" };
      const partition = await this.registry.open(uid, binding.mode);
      return { kind: "upstream", context: { partition, capture: true } };
    }
    const window = await this.bootstrap.current();
    if (window) return { kind: "local" }; // local-mode bootstrap window
    // Unknown UID, nothing armed: stay out of the way — forward to the vendor
    // unchanged, touch nothing beyond the in-memory contact, and leave a
    // trace for the operator (upstream bootstrap pulls vendor history itself).
    log(`sync operation for unknown dataFileUID forwarded to the vendor without capture (no binding, no armed bootstrap)`);
    return { kind: "upstream", context: { capture: false } };
  }

  noteVendorContact(rawUid: string, contact: VendorContact): void {
    try {
      this.vendorContacts.set(normalizeDataFileUid(rawUid), contact);
    } catch {
      /* invalid UID — nothing to key the contact on */
    }
  }

  vendorContact(rawUid: string): VendorContact | undefined {
    try {
      return this.vendorContacts.get(normalizeDataFileUid(rawUid));
    } catch {
      return undefined;
    }
  }

  /** All dataFileUIDs whose sync traffic has been seen since server start. */
  vendorContactUids(): string[] {
    return [...this.vendorContacts.keys()];
  }

  /** A CONNECT tunnel to the vendor sync host blinds the mirror; record it. */
  async noteVendorConnect(): Promise<void> {
    await this.prepareRoot();
    const target = path.join(this.stateRoot, "mirror-blind.json");
    await fs.writeFile(target, `${JSON.stringify({ mirrorBlind: true, at: new Date().toISOString() }, null, 2)}\n`);
    log("HTTPS CONNECT to the vendor sync host: sync is TLS-tunneled and the upstream mirror is blind — uncheck \"Use secure connection\" in MLO's cloud login");
  }

  async mirrorBlind(): Promise<boolean> {
    try {
      await fs.stat(path.join(this.stateRoot, "mirror-blind.json"));
      return true;
    } catch {
      return false;
    }
  }

  async noteMirrorUnhealthy(): Promise<void> {
    await this.prepareRoot();
    const target = path.join(this.stateRoot, "mirror-health.json");
    await fs.writeFile(target, `${JSON.stringify({ healthy: false, at: new Date().toISOString() }, null, 2)}\n`);
  }

  async mirrorHealthy(): Promise<boolean> {
    try {
      await fs.stat(path.join(this.stateRoot, "mirror-health.json"));
      return false;
    } catch {
      return true;
    }
  }

  /** The partition bound to a profile, or a description of why none is. */
  async boundPartition(profilePath: string): Promise<
    | { kind: "unbound"; binding?: ProfileBinding }
    | { kind: "bound"; binding: ProfileBinding; partition: PartitionHandle; lifecycle: PartitionLifecycle }
  > {
    const binding = await this.bindings.forProfile(profilePath);
    if (!binding?.dataFileUID) return { kind: "unbound", ...(binding ? { binding } : {}) };
    await this.prepareRoot();
    const partition = await this.registry.open(binding.dataFileUID, binding.mode);
    return { kind: "bound", binding, partition, lifecycle: await partition.lifecycle() };
  }

  /** Resolve the state for a `/v1` call with an optional `dataFileUID`. */
  async stateForV1(rawUid: string | undefined): Promise<CloudState> {
    if (rawUid === undefined) return this.defaultState();
    await this.prepareRoot();
    const partition = await this.registry.open(rawUid);
    return partition.state;
  }

  /**
   * Create the private state root on first use, restricting it to the current
   * user. Node has no native Windows ACL API, so this is a best-effort
   * `icacls` call; failure only logs — the root still works, with inherited
   * per-user `%LOCALAPPDATA%` permissions in the default location.
   */
  async ensureRoot(): Promise<void> {
    return this.prepareRoot();
  }

  private async prepareRoot(): Promise<void> {
    if (this.rootPrepared) return;
    this.rootPrepared = true;
    let created = false;
    try {
      await fs.mkdir(this.stateRoot, { recursive: false });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await fs.mkdir(this.stateRoot, { recursive: true });
        created = true;
      }
    }
    if (created && process.platform === "win32") {
      const user = process.env.USERNAME ?? os.userInfo().username;
      execFile(
        "icacls",
        [this.stateRoot, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`],
        (error) => {
          if (error) log(`could not restrict state root ACL (non-fatal): ${error.message}`);
        },
      );
    }
  }
}

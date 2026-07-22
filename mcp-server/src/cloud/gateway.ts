import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudState } from "./state.js";
import { BindingStore, type ProfileBinding } from "./binding.js";
import { BootstrapController } from "./bootstrap.js";
import { normalizeDataFileUid, PartitionRegistry, type PartitionHandle, type PartitionLifecycle, type PartitionMode } from "./partition.js";
import type { UpstreamContext } from "./upstream.js";
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
 * right storage:
 *
 * - **Legacy mode** (`legacyStateDir` set): the original single delta log.
 *   Used for the repo demo profile and explicit `MLO_CLOUD_STATE_DIR`
 *   overrides. The directory is treated as disposable demo evidence — it can
 *   mix histories (the repo `messages/` provably does) and must never become
 *   a bootstrap baseline for a real profile.
 * - **Partitioned mode** (`stateRoot` set): per-`dataFileUID` partitions under
 *   a private root outside the checkout. SOAP requests must carry a valid
 *   `dataFileUID` to be routed; `/v1` calls may address a partition explicitly
 *   or fall back to the session default.
 */
export interface CloudGatewayOptions {
  stateRoot?: string;
  legacyStateDir?: string;
  defaultMode: PartitionMode;
}

export class CloudGateway {
  readonly registry?: PartitionRegistry;
  readonly bindings?: BindingStore;
  readonly bootstrap?: BootstrapController;
  readonly legacyState?: CloudState;
  readonly stateRoot?: string;
  readonly legacyStateDir?: string;
  readonly defaultMode: PartitionMode;
  private unboundState?: CloudState;
  private rootPrepared = false;
  private sessionAuthorities = new Map<string, { authority: SoapAuthority; expires: number }>();

  constructor(options: CloudGatewayOptions) {
    this.defaultMode = options.defaultMode;
    if (options.legacyStateDir) {
      this.legacyStateDir = options.legacyStateDir;
      this.legacyState = new CloudState(options.legacyStateDir);
    } else if (options.stateRoot) {
      this.stateRoot = options.stateRoot;
      this.registry = new PartitionRegistry(options.stateRoot, options.defaultMode);
      this.bindings = new BindingStore(options.stateRoot);
      this.bootstrap = new BootstrapController(options.stateRoot);
    } else {
      throw new Error("CloudGateway requires either a stateRoot or a legacyStateDir");
    }
  }

  get partitioned(): boolean {
    return this.registry !== undefined;
  }

  /** Where the sync observer writes its structural summaries. */
  observerDir(): string {
    return this.legacyStateDir ?? this.stateRoot!;
  }

  /**
   * Default state for callers that address no specific partition: the legacy
   * log, or a placeholder "unbound" log under the private root. The unbound
   * log exists so `/v1/status` (the attach probe) and tools keep a stable
   * shape before a profile is bound; it is never routed to by SOAP.
   */
  defaultState(): CloudState {
    if (this.legacyState) return this.legacyState;
    this.unboundState ??= new CloudState(path.join(this.stateRoot!, "unbound"));
    return this.unboundState;
  }

  /**
   * Decide the authority for one SOAP sync operation from its parsed fields.
   * Local termination stays the answer for legacy mode and local-mode
   * partitions; upstream-bound (and unknown, windowless) dataFileUIDs belong
   * to the vendor. The decision is pinned per sessionID so a binding change
   * can never switch authorities mid-session.
   */
  async decideAuthority(fields: Record<string, unknown>): Promise<SoapAuthority> {
    if (this.legacyState) return { kind: "local" };
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
    const binding = await this.bindings!.forUid(uid);
    if (binding) {
      if (binding.mode === "local") return { kind: "local" };
      const partition = await this.registry!.open(uid);
      return { kind: "upstream", context: { partition, capture: true, bootstrapping: false } };
    }
    const window = await this.bootstrap!.current();
    if (window && window.mode === "upstream") {
      const firstContact = !window.dataFileUID;
      try {
        await this.bootstrap!.noteUidSeen(uid);
      } catch (error) {
        return { kind: "reject", message: error instanceof Error ? error.message : String(error) };
      }
      const partition = await this.registry!.open(uid);
      if (firstContact && !(await partition.isEmpty())) {
        return { kind: "reject", message: "bootstrap requires an empty partition, but this dataFileUID already has history" };
      }
      return { kind: "upstream", context: { partition, capture: true, bootstrapping: true } };
    }
    if (window) return { kind: "local" }; // local-mode bootstrap window
    // Unknown UID, nothing armed: stay out of the way — forward to the vendor
    // unchanged, touch nothing, and leave a trace for the operator.
    log(`sync operation for unknown dataFileUID forwarded to the vendor without capture (no binding, no armed bootstrap)`);
    return { kind: "upstream", context: { capture: false, bootstrapping: false } };
  }

  /** A CONNECT tunnel to the vendor sync host blinds the mirror; record it. */
  async noteVendorConnect(): Promise<void> {
    if (!this.stateRoot) return;
    await this.prepareRoot();
    const target = path.join(this.stateRoot, "mirror-blind.json");
    await fs.writeFile(target, `${JSON.stringify({ mirrorBlind: true, at: new Date().toISOString() }, null, 2)}\n`);
    log("HTTPS CONNECT to the vendor sync host: sync is TLS-tunneled and the upstream mirror is blind — uncheck \"Use secure connection\" in MLO's cloud login");
  }

  async mirrorBlind(): Promise<boolean> {
    if (!this.stateRoot) return false;
    try {
      await fs.stat(path.join(this.stateRoot, "mirror-blind.json"));
      return true;
    } catch {
      return false;
    }
  }

  async noteMirrorUnhealthy(): Promise<void> {
    if (!this.stateRoot) return;
    await this.prepareRoot();
    const target = path.join(this.stateRoot, "mirror-health.json");
    await fs.writeFile(target, `${JSON.stringify({ healthy: false, at: new Date().toISOString() }, null, 2)}\n`);
  }

  async mirrorHealthy(): Promise<boolean> {
    if (!this.stateRoot) return true;
    try {
      await fs.stat(path.join(this.stateRoot, "mirror-health.json"));
      return false;
    } catch {
      return true;
    }
  }

  /**
   * The partition bound to a profile, or a description of why none is. Legacy
   * mode reports itself as such — the legacy log is demo evidence, exempt
   * from binding and lifecycle gating.
   */
  async boundPartition(profilePath: string): Promise<
    | { kind: "legacy"; state: CloudState }
    | { kind: "unbound"; binding?: ProfileBinding }
    | { kind: "bound"; binding: ProfileBinding; partition: PartitionHandle; lifecycle: PartitionLifecycle }
  > {
    if (this.legacyState) return { kind: "legacy", state: this.legacyState };
    const binding = await this.bindings!.forProfile(profilePath);
    if (!binding?.dataFileUID) return { kind: "unbound", binding };
    await this.prepareRoot();
    const partition = await this.registry!.open(binding.dataFileUID);
    return { kind: "bound", binding, partition, lifecycle: await partition.lifecycle() };
  }

  /** Resolve the state for a `/v1` call with an optional `dataFileUID`. */
  async stateForV1(rawUid: string | undefined): Promise<CloudState> {
    if (rawUid === undefined) return this.defaultState();
    if (this.legacyState) return this.legacyState;
    await this.prepareRoot();
    const partition = await this.registry!.open(rawUid);
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
    if (this.rootPrepared || !this.stateRoot) return;
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

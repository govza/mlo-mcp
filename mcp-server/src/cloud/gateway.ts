import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BindingStore, type ProfileBinding } from "./binding.js";
import { SightingStore, type UnboundSighting } from "./sightings.js";
import { DeadLetterStore } from "./dead-letter.js";
import { normalizeDataFileUid, PartitionRegistry, type PartitionStore, type PartitionLifecycle } from "./partition.js";
import type { RowStore } from "./row-store.js";
import type { InjectionQueue } from "./injection-queue.js";
import type { VendorContact } from "./upstream.js";
import { log } from "../log.js";

/**
 * Which authority answers one SOAP sync operation. All three operations of a
 * profile session must resolve to the SAME authority (the vendor protocol's
 * session is one logical unit), so decisions are pinned per `sessionID`.
 */
export type SoapAuthority =
  | { kind: "upstream" }
  | { kind: "reject"; message: string };

const SESSION_PIN_TTL_MS = 10 * 60 * 1000;

/** The endpoint's own vendor-client exchange journal, one JSON record per line. */
export const VENDOR_CLIENT_FILE = "vendor-client.jsonl";

/** The bound profile is syncing under a different identity: writes would be lost. */
export interface BindingMismatch {
  profilePath: string;
  boundDataFileUID: string;
  observedDataFileUIDs: string[];
}

/**
 * Routes every cloud-state access — SOAP, MCP tools, status — to the
 * per-`dataFileUID` partition it belongs to, under one private state root
 * outside any checkout.
 */
export interface CloudGatewayOptions {
  stateRoot: string;
}

export class CloudGateway {
  readonly registry: PartitionRegistry;
  readonly bindings: BindingStore;
  readonly sightings: SightingStore;
  /** Shared, not per-call: its write chain is what serialises concurrent refusals. */
  readonly deadLetters: DeadLetterStore;
  readonly stateRoot: string;
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
    this.sightings = new SightingStore(options.stateRoot);
    this.deadLetters = new DeadLetterStore(options.stateRoot);
  }

  /** Where the sync observer writes its structural summaries. */
  observerDir(): string {
    return this.stateRoot;
  }

  /**
   * Append one of the endpoint's OWN vendor-client exchanges to
   * `vendor-client.jsonl` — operations, cursor values, result flags and
   * payload sizes; credential fields never reach this seam. The resident
   * logs to stderr, which dies with the process; this file is what the
   * post-mortem of a failed write reads. Awaitable so an exchange's record
   * is on disk before its outcome is acted on; a failure to record only logs.
   */
  async noteVendorExchange(record: Record<string, unknown>): Promise<void> {
    try {
      await this.prepareRoot();
      const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
      await fs.appendFile(path.join(this.stateRoot, VENDOR_CLIENT_FILE), line);
    } catch (error) {
      log(`vendor exchange log write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Decide the authority for one SOAP sync operation from its parsed fields.
   * Everything the endpoint can attribute forwards to the vendor; only
   * requests it cannot route at all are rejected. The decision is pinned per
   * sessionID so a binding change can never switch authorities mid-session.
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
    if (!rawUid) return { kind: "reject", message: "dataFileUID is required to route this sync operation" };
    let uid: string;
    try {
      uid = normalizeDataFileUid(rawUid);
    } catch (error) {
      return { kind: "reject", message: error instanceof Error ? error.message : String(error) };
    }
    await this.prepareRoot();
    const binding = await this.bindings.forUid(uid);
    if (binding?.mode === "local") {
      // The local replacement server was deleted with the delta log
      // (ADR-0005); a partition bound to it has no authority left to answer.
      return {
        kind: "reject",
        message: "this dataFileUID is bound in the removed local mode; the endpoint only proxies vendor sync now",
      };
    }
    if (!binding) {
      // Unknown UID: stay out of the way — forward to the vendor unchanged,
      // touch nothing beyond the in-memory contact, and leave a trace for the
      // operator. The sighting is recorded because this decision is the only
      // place that ever learns the identity MLO actually syncs; it changes no
      // routing, and a failure to record it must never reach the app.
      log(`sync operation for unknown dataFileUID forwarded to the vendor (no binding)`);
      await this.sightings.note(uid).catch(() => undefined);
    }
    return { kind: "upstream" };
  }

  /**
   * Recorded sightings whose UID is still unbound. A UID that has since been
   * bound is no longer evidence of anything, so the signal clears itself
   * without a second write path.
   */
  async unboundSightings(): Promise<UnboundSighting[]> {
    const recorded = await this.sightings.all();
    if (!recorded.length) return recorded;
    const bound = new Set((await this.bindings.list()).map((binding) => binding.dataFileUID));
    return recorded.filter((sighting) => !bound.has(sighting.dataFileUID));
  }

  /**
   * The binding-mismatch fault: this profile IS bound, but the app has been
   * seen syncing a different, unbound identity — so the bound partition is one
   * MLO will never read and every write into it would vanish. A profile with
   * no binding at all is first-run setup, not a mismatch, and stays silent;
   * that is what preserves the "stay out of the way" guarantee for a profile
   * this server was never asked to manage.
   */
  async bindingMismatch(profilePath: string): Promise<BindingMismatch | undefined> {
    const binding = await this.bindings.forProfile(profilePath);
    if (!binding?.dataFileUID) return undefined;
    const observed = (await this.unboundSightings())
      .filter((sighting) => sighting.dataFileUID !== binding.dataFileUID)
      .map((sighting) => sighting.dataFileUID);
    if (!observed.length) return undefined;
    return { profilePath, boundDataFileUID: binding.dataFileUID, observedDataFileUIDs: observed };
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

  /** The partition bound to a profile, or a description of why none is. */
  async boundPartition(profilePath: string): Promise<
    | { kind: "unbound"; binding?: ProfileBinding }
    | { kind: "bound"; binding: ProfileBinding; partition: PartitionStore; lifecycle: PartitionLifecycle }
  > {
    const binding = await this.bindings.forProfile(profilePath);
    if (!binding?.dataFileUID) return { kind: "unbound", ...(binding ? { binding } : {}) };
    await this.prepareRoot();
    const partition = await this.registry.open(binding.dataFileUID, binding.mode);
    return { kind: "bound", binding, partition, lifecycle: await partition.lifecycle() };
  }

  /**
   * The two bound-partition stores a session composes itself around: the row
   * store identity and authoring read, and the injection queue the read path
   * overlays. Both undefined when the profile is unbound (or the root
   * unreadable) — every resolution then honestly reads as unconfirmed, every
   * write refuses, and there is no queue to overlay because nothing could have
   * been accepted. Resolved once at composition time; a binding that appears
   * later reaches new sessions.
   */
  async boundStores(profilePath: string): Promise<{ rows?: RowStore; queue?: InjectionQueue }> {
    const bound = await this.boundPartition(profilePath).catch(() => undefined);
    if (bound?.kind !== "bound") return {};
    return { rows: bound.partition.rows, queue: bound.partition.queue };
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

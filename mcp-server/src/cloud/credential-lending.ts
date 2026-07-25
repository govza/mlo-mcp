import { cursorToDecimalString, type CloudCursor } from "./cursor.js";
import { generateGuid } from "./delta.js";
import type { CloudGateway } from "./gateway.js";
import { normalizeDataFileUid, type PartitionHandle } from "./partition.js";
import { pullVendorHistory, UpstreamWriteSession, type VendorContact } from "./upstream.js";
import { log } from "../log.js";

/**
 * The resident endpoint's side of the credential-lending seam: the three vendor
 * round trips that need the contact this process alone holds, and nothing else.
 * Authoring, projections and the binding all stay in the calling MCP session,
 * which reaches the same state root through the filesystem
 * ([ADR-0003](../../../docs/adr/0003-resident-endpoint.md)).
 *
 * A write is two round trips because the vendor session spans both: `begin`
 * refreshes the mirror and keeps that session open, `commit` uploads into it.
 * Splitting them across a process boundary widens the window in which a mobile
 * or vendor edit can land between the two — so the mirror cursor `begin`
 * returns is re-checked at `commit`. Full-row rewrites author from the rows
 * that cursor describes; if the mirror has moved, those rows are superseded and
 * committing them would silently clobber the edit that moved it.
 */

/** Long enough to cover an mlo.exe export between the two calls. */
const SESSION_TTL_MS = 10 * 60 * 1000;

interface PendingWrite {
  session: UpstreamWriteSession;
  partition: PartitionHandle;
  /** Mirror high-water at the moment the author was handed its rows. */
  baseline: CloudCursor;
  expires: number;
}

function refuse(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export class CredentialLender {
  private pending = new Map<string, PendingWrite>();

  constructor(private readonly gateway: CloudGateway) {}

  /** Refresh the mirror and hold the vendor session open for one commit. */
  async begin(rawUid: string): Promise<{ session: string; cursor: string }> {
    const partition = await this.partitionFor(rawUid);
    const session = new UpstreamWriteSession(partition, this.contactFor(rawUid));
    await session.refresh();
    const baseline = await partition.mirrorState.highWater();
    const token = generateGuid();
    this.sweep();
    this.pending.set(token, { session, partition, baseline, expires: Date.now() + SESSION_TTL_MS });
    return { session: token, cursor: cursorToDecimalString(baseline) };
  }

  /** Upload the authored envelope, or refuse because its rows went stale. */
  async commit(token: string, envelope: Uint8Array): Promise<string> {
    this.sweep();
    const pending = this.pending.get(token);
    if (!pending) {
      throw refuse(
        409,
        "this write session is not open on the sync endpoint — it expired, or the endpoint restarted after the " +
          "rows were read. Nothing was committed; retry the write",
      );
    }
    this.pending.delete(token);
    const current = await pending.partition.mirrorState.highWater();
    if (current !== pending.baseline) {
      await pending.session.release();
      throw refuse(
        409,
        `the cloud file moved from version ${cursorToDecimalString(pending.baseline)} to ` +
          `${cursorToDecimalString(current)} while this write was being authored — MLO, mobile or another session ` +
          "changed it. The rows this write carries are superseded, so nothing was committed; retry and it will be " +
          "authored from the current ones",
      );
    }
    return pending.session.commit(envelope);
  }

  /**
   * The vendor's complete history for one cloud file (a bootstrap's pull).
   * Creates no partition: what to do with the bytes is the session's decision.
   */
  async history(rawUid: string): Promise<{ version: string; envelope: Buffer }> {
    const pulled = await pullVendorHistory(this.contactFor(rawUid), this.normalizedUid(rawUid));
    return { version: cursorToDecimalString(pulled.version), envelope: pulled.envelope };
  }

  /** Release every held vendor session; the endpoint is going away. */
  async close(): Promise<void> {
    const outstanding = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(outstanding.map((entry) => entry.session.release()));
  }

  /** The single place a missing contact is reported, in one wording. */
  private contactFor(rawUid: string): VendorContact {
    const contact = this.gateway.vendorContact(rawUid);
    if (!contact) {
      throw refuse(
        409,
        "this needs the profile's vendor sync credentials, which the sync endpoint holds in memory only: " +
          "run one sync in MLO through this proxy since the endpoint started, then retry",
      );
    }
    return contact;
  }

  /** A malformed UID is the caller's fault, not a credential problem. */
  private normalizedUid(rawUid: string): string {
    try {
      return normalizeDataFileUid(rawUid);
    } catch (error) {
      throw refuse(400, error instanceof Error ? error.message : String(error));
    }
  }

  private partitionFor(rawUid: string): Promise<PartitionHandle> {
    return this.gateway.registry.open(this.normalizedUid(rawUid), "upstream");
  }

  /** Drop sessions nobody committed — a session can die mid-author. */
  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.pending) {
      if (entry.expires > now) continue;
      this.pending.delete(token);
      void entry.session.release().catch(() => undefined);
      log("released an upstream write session that was opened but never committed");
    }
  }
}

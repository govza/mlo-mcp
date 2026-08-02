import { randomUUID } from "node:crypto";
import type { AutoInitializer } from "./auto-init.js";
import type { CloudGateway } from "./gateway.js";
import type { PartitionStore } from "./partition.js";
import type { QueuedWrite, WriteVerb } from "./injection-queue.js";
import type { Problem } from "./problem.js";
import { mergeDeltas } from "./delta-merge.js";
import { normalizeGuid } from "./guid.js";
import { documentFromDeltaRows, TODO_ITEMS_HEADER } from "./mlo-schema.js";
import { harvestTaskRows } from "./row-store.js";
import { packEnvelope, unpackEnvelope } from "./envelope.js";
import { decodeForwardBody, type ForwardResult } from "./upstream.js";
import {
  buildGetFileTsResponse,
  buildGetModificationsResponse,
  GET_FILE_TS,
  peekSoapResponseFields,
  soapFieldText as text,
} from "./soap.js";
import { DEFAULT_WRITE_TTL_MS } from "../config.js";
import type { DeltaRow, WriteId, WriteReceipt } from "../repo/mlo-repository.js";
import { log } from "../log.js";

/**
 * The resident write path (spec section 2, all nine mechanics; proven live on
 * branch `prototype/single-channel-injection`):
 *
 * - `accept` is the durable half of `POST /v1/write`: the rows are fsync'd
 *   into the bound partition's injection queue before "accepted" exists.
 * - `enrichGetResponse` injects every pending write into a forwarded Get for
 *   the BOUND dataFileUID only, presenting `vendorVersion + 1` (transient —
 *   MLO stores the vendor's real stamp after its own Apply).
 * - `observeApply` marks a row delivered only when MLO's own Apply carries
 *   its UID with MATCHING content; same UID with differing content is
 *   `superseded` (a conflict-dialog local-wins), never delivered.
 * - `nudgeFileTs` answers MLO's background GetFileTS poll advanced while the
 *   queue is non-empty, verbatim otherwise — what induces a session for a
 *   pure-MCP write on a quiet MLO.
 * - TTL expiry is swept lazily wherever the queue is consulted (nothing here
 *   is periodic): an expired row dead-letters, records a `write-expired`
 *   outcome, and is never injected again.
 * - Re-delivery is the safety net only: a write pinned to an in-flight
 *   session is not re-injected until the session resolves or the pin ages
 *   out — an eager re-delivery would fight MLO's own 3 s Apply retry.
 *
 * Everything called from the forward path is best-effort: callers treat any
 * throw as "forward the vendor's payload verbatim" (the non-interference
 * invariant, spec section 6).
 */

/** Columns MLO may legitimately restamp on import; excluded from the supersede compare. */
export const SUPERSEDE_VOLATILE_COLUMNS: ReadonlySet<string> = new Set(["LastModified", "ItemIndex"]);

/**
 * How long an injected write is pinned to its session before re-delivery may
 * touch it again. Long enough to sit out MLO's own Apply retry and a human at
 * the conflict dialog; short enough that a killed session frees the row for
 * the next Get.
 */
const IN_FLIGHT_TTL_MS = 10 * 60_000;

/**
 * How long an injected write may ride an unresolved session before the gauge
 * calls it stalled (spec section 6, "a Get without a following Apply beyond
 * ~N s"). MLO applies a delivered row within about a second, so anything this
 * old is waiting on something — in practice the conflict dialog.
 */
const SESSION_HELD_OPEN_MS = 30_000;

/** The stamp a Get presents: ride the vendor's own advance, else bump past MLO's stored cursor. */
export function presentedGetVersion(vendorMax: bigint, newerThan: bigint): bigint {
  return vendorMax > newerThan ? vendorMax : newerThan + 1n;
}

/**
 * The stamp a nudged GetFileTS presents: past MLO's last observed stored
 * cursor when known, past the vendor's own answer when not.
 */
export function nudgedFileTsVersion(vendorTs: bigint, lastStored: bigint | undefined): bigint {
  const floor = (lastStored ?? vendorTs) + 1n;
  return vendorTs > floor ? vendorTs : floor;
}

export interface DescribedWrite {
  uid: string;
  verb: WriteVerb;
  caption?: string;
}

function column(name: string): number {
  return TODO_ITEMS_HEADER.indexOf(name);
}

/**
 * The identity of a write, read off its rows: the seam carries bare rows
 * (spec section 4), so uid / verb / caption are derived here rather than
 * trusted from a second channel. The verb is best-effort labelling for
 * receipts and dead letters — nothing routes on add-vs-update.
 */
export function describeWriteRows(rows: readonly DeltaRow[]): DescribedWrite | undefined {
  const task = rows.find((row) => row.section === "TodoItems");
  if (task) {
    let uid: string;
    try { uid = normalizeGuid(task.values[column("UID")] ?? ""); }
    catch { return undefined; }
    const caption = task.values[column("Caption")] || undefined;
    const completed = (task.values[column("CompletionDateTime")] ?? "") !== "";
    const created = task.values[column("CreatedDate")] ?? "";
    const modified = task.values[column("LastModified")] ?? "";
    const verb: WriteVerb = completed ? "complete" : created !== "" && created === modified ? "add" : "update";
    return { uid, verb, ...(caption ? { caption } : {}) };
  }
  const tombstone = rows.find((row) => row.section === "TodoItems.Deleted");
  if (tombstone) {
    try {
      return { uid: normalizeGuid(tombstone.values[0] ?? ""), verb: "delete" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface NamedRow {
  header: readonly string[];
  cells: readonly string[];
}

/**
 * Whether MLO's Apply carried the same row content the endpoint injected.
 * Compared by column name over both headers, blank-padded, with the volatile
 * columns MLO restamps excluded — a mismatch anywhere else means the user's
 * own row won a conflict dialog and the write was superseded, not delivered.
 */
export function rowsMatch(injected: NamedRow, applied: NamedRow): boolean {
  const columns = new Set([...injected.header, ...applied.header]);
  for (const name of columns) {
    if (SUPERSEDE_VOLATILE_COLUMNS.has(name)) continue;
    const left = injected.cells[injected.header.indexOf(name)] ?? "";
    const right = applied.cells[applied.header.indexOf(name)] ?? "";
    if (left !== right) return false;
  }
  return true;
}

export type AcceptOutcome =
  | { kind: "accepted"; writeId: WriteId; uid: string; verb: WriteVerb; caption?: string; expiresAt: string }
  | { kind: "refused"; httpStatus: number; problem: Problem };

export interface WritePathOptions {
  ttlMs?: number;
  now?: () => Date;
  inFlightTtlMs?: number;
  /**
   * The guarded auto-initializer. A write into an unbound profile is the second
   * trigger for it (the first is a proxied sync): the server tries to
   * initialize itself and, failing that, refuses with the guard that stopped
   * it rather than a generic "not ready".
   */
  autoInit?: AutoInitializer;
}

interface Pin {
  session: string;
  atMs: number;
}

function refusal(httpStatus: number, problem: Problem): AcceptOutcome {
  return { kind: "refused", httpStatus, problem };
}

function isDeltaRow(value: unknown): value is DeltaRow {
  const row = value as Partial<DeltaRow> | null;
  return !!row && typeof row.section === "string" &&
    Array.isArray(row.values) && row.values.every((cell) => typeof cell === "string");
}

/** ZIP local-file-header magic — ordinary Get/Apply payloads are ZIP envelopes. */
function isZipPayload(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function parseStamp(value: string | undefined): bigint | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

export class WritePath {
  private readonly ttlMs: number;
  private readonly inFlightTtlMs: number;
  private readonly now: () => Date;
  /** writeId -> the session an injection pinned it to. In-memory: a resident restart safely re-delivers. */
  private readonly inFlight = new Map<WriteId, Pin>();
  /** partition key -> MLO's stored remote cursor, as last observed (Get `newerThan`, Apply `newServerTimeStamp`). */
  private readonly stored = new Map<string, bigint>();
  private readonly autoInit: AutoInitializer | undefined;

  constructor(
    private readonly gateway: CloudGateway,
    options: WritePathOptions = {},
  ) {
    this.autoInit = options.autoInit;
    this.ttlMs = options.ttlMs ?? DEFAULT_WRITE_TTL_MS;
    this.inFlightTtlMs = options.inFlightTtlMs ?? IN_FLIGHT_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The partition a forwarded exchange may inject into: the BINDING is the
   * injection gate (spec section 5) — a UID nobody explicitly bound forwards
   * verbatim forever, no matter what it queues elsewhere.
   */
  private async boundPartition(rawUid: string | undefined): Promise<PartitionStore | undefined> {
    if (!rawUid) return undefined;
    let binding;
    try {
      binding = await this.gateway.bindings.forUid(rawUid);
    } catch {
      return undefined; // not GUID-shaped — routing already rejected it
    }
    if (!binding?.dataFileUID || binding.mode !== "upstream") return undefined;
    return this.gateway.registry.open(binding.dataFileUID, binding.mode);
  }

  /**
   * Lazy TTL sweep, run wherever the queue is consulted. The partition resolves
   * its own expiries; what stays here is what lives outside the handle — the
   * shared dead-letter file and the in-memory pins.
   */
  private async expireDue(partition: PartitionStore): Promise<void> {
    const now = this.now();
    for (const { write, detail } of await partition.expireDue(now)) {
      this.inFlight.delete(write.writeId);
      await this.gateway.deadLetters.record({
        at: now.toISOString(),
        tool: `write:${write.verb}`,
        reason: detail,
        content: write.caption ?? write.uid,
      });
      log(`write ${write.writeId} (${write.verb} ${write.uid}) expired into the dead-letter file`);
    }
  }

  /** Queued writes not currently riding an unresolved session. */
  private async deliverable(partition: PartitionStore): Promise<QueuedWrite[]> {
    const nowMs = this.now().getTime();
    const pending = await partition.queue.pending();
    return pending.filter((write) => {
      const pin = this.inFlight.get(write.writeId);
      if (!pin) return true;
      if (nowMs - pin.atMs >= this.inFlightTtlMs) {
        this.inFlight.delete(write.writeId);
        return true;
      }
      return false;
    });
  }

  /**
   * The session-held-open gauge (spec section 6): writes injected into a Get
   * that no Apply has resolved for longer than `SESSION_HELD_OPEN_MS`. That is
   * the endpoint's only cross-process view of a pending conflict dialog — MLO
   * normally applies within a second, so a pin this old means delivery is
   * stalled, most likely on a human.
   *
   * A young pin is not reported: a healthy exchange in flight is not a stall.
   * Pins past the in-flight TTL are not either — that session is written off
   * and the row is deliverable again. In-memory and process-local by nature (a
   * pin is a fact about a live exchange), which is why an attached session can
   * only learn it by asking: it rides `/v1/status`, not the state root. A pure
   * query: the sweep that drops released pins belongs to `deliverable()`.
   */
  writesHeldOpen(): WriteId[] {
    const nowMs = this.now().getTime();
    return [...this.inFlight]
      .filter(([, pin]) => {
        const age = nowMs - pin.atMs;
        return age >= SESSION_HELD_OPEN_MS && age < this.inFlightTtlMs;
      })
      .map(([writeId]) => writeId);
  }

  /** Durable accept: resolves `accepted` only after the queue write is fsync'd. */
  async accept(profilePath: unknown, rows: unknown): Promise<AcceptOutcome> {
    if (typeof profilePath !== "string" || !profilePath.length) {
      return refusal(400, {
        kind: "invalid-request",
        title: "a write must name the profile whose bound partition carries it",
        retryable: false,
      });
    }
    if (!Array.isArray(rows) || !rows.length || !rows.every(isDeltaRow)) {
      return refusal(400, {
        kind: "invalid-request",
        title: "a write carries a non-empty array of section-addressed rows",
        retryable: false,
      });
    }
    const described = describeWriteRows(rows);
    if (!described) {
      return refusal(400, {
        kind: "invalid-request",
        title: "the rows carry no TodoItems row and no tombstone with a GUID-shaped UID",
        retryable: false,
      });
    }
    try {
      // Refuse rows no envelope can carry NOW, at the gate — not at injection
      // time, where a failure would silently strand the accepted write.
      documentFromDeltaRows(rows);
    } catch (error) {
      return refusal(400, {
        kind: "invalid-request",
        title: error instanceof Error ? error.message : String(error),
        retryable: false,
      });
    }
    let bound = await this.gateway.boundPartition(profilePath);
    if (bound.kind !== "bound") {
      const initialized = await this.autoInit?.attempt();
      if (initialized && initialized.kind === "refused") return refusal(409, initialized.problem);
      bound = await this.gateway.boundPartition(profilePath);
    }
    if (bound.kind !== "bound") {
      return refusal(409, {
        kind: "partition-not-ready",
        title: "this profile has no bound cloud partition — writes have nowhere to land",
        retryable: "after-user-action",
        remedy: 'sync MLO once through the proxy ("Use secure connection" unchecked) so the endpoint can bind it',
      });
    }
    await this.expireDue(bound.partition);
    const now = this.now();
    const write: QueuedWrite = {
      writeId: `w-${randomUUID()}`,
      uid: described.uid,
      verb: described.verb,
      ...(described.caption ? { caption: described.caption } : {}),
      rows,
      queuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    await bound.partition.queue.enqueue(write);
    return {
      kind: "accepted",
      writeId: write.writeId,
      uid: write.uid,
      verb: write.verb,
      ...(write.caption ? { caption: write.caption } : {}),
      expiresAt: write.expiresAt,
    };
  }

  /** The five-state answer for one receipt, from whichever partition holds it. */
  async status(writeId: WriteId): Promise<WriteReceipt | undefined> {
    for (const summary of await this.gateway.registry.list()) {
      const partition = await this.gateway.registry.resolveExisting(summary.dataFileUID);
      if (!partition) continue;
      await this.expireDue(partition);
      const receipt = await partition.findWrite(writeId);
      if (receipt) return receipt;
    }
    return undefined;
  }

  /**
   * Inject pending writes into a forwarded Get response for the bound UID.
   * Returns the rebuilt response bytes, or undefined for "send the vendor's
   * payload verbatim". Called from the forward path: the caller treats any
   * throw as undefined.
   */
  async enrichGetResponse(requestFields: Record<string, unknown>, result: ForwardResult): Promise<Uint8Array | undefined> {
    const partition = await this.boundPartition(text(requestFields, "dataFileUID"));
    if (!partition) return undefined;
    const newerThan = parseStamp(text(requestFields, "newerThan"));
    if (newerThan !== undefined) this.stored.set(partition.key, newerThan);
    if (result.status !== 200) return undefined;

    await this.expireDue(partition);
    const pending = await this.deliverable(partition);
    if (!pending.length) return undefined;

    const fields = peekSoapResponseFields(decodeForwardBody(result), "GetModificationsBytesEx");
    if (text(fields, "GetModificationsBytesExResult") !== "true") return undefined;
    const vendorMax = parseStamp(text(fields, "maxVersion"));
    if (vendorMax === undefined) return undefined;
    const encoded = text(fields, "data")?.replace(/\s+/g, "");
    let vendorDocument;
    if (encoded) {
      const bytes = Buffer.from(encoded, "base64");
      // A raw projection (full-history shape) is not a delta envelope; the
      // one session that carries it is not one to write into.
      if (!isZipPayload(bytes)) return undefined;
      vendorDocument = unpackEnvelope(bytes);
    }

    const session = text(requestFields, "sessionID") ?? "";
    const injectedDocument = mergeDeltas(pending.map((write) => documentFromDeltaRows(write.rows)));
    const merged = vendorDocument ? mergeDeltas([vendorDocument, injectedDocument]) : injectedDocument;
    const presented = presentedGetVersion(vendorMax, newerThan ?? 0n);
    const payload = Buffer.from(packEnvelope(merged)).toString("base64");

    const nowMs = this.now().getTime();
    for (const write of pending) this.inFlight.set(write.writeId, { session, atMs: nowMs });
    // MLO persists the presented stamp after its Apply — even across an
    // aborted session (live finding) — so it is the stored cursor from here.
    this.stored.set(partition.key, presented);
    // The injected rows are now the latest this partition has seen.
    await partition.rows.ingest(injectedDocument, "injected").catch((error) =>
      log(`row-store ingest of injected rows failed (injection unaffected): ${error instanceof Error ? error.message : String(error)}`));
    log(`injected ${pending.length} pending write(s) into a forwarded Get for ${partition.uid} (presented ${presented})`);
    return buildGetModificationsResponse(presented.toString(), payload);
  }

  /**
   * Watch MLO's own Apply carry injected rows back out. Delivered requires
   * matching content; same UID with differing content is superseded. Called
   * fire-and-forget after the response has been written.
   */
  async observeApply(requestFields: Record<string, unknown>, result: ForwardResult): Promise<void> {
    const partition = await this.boundPartition(text(requestFields, "dataFileUID"));
    if (!partition) return;
    const session = text(requestFields, "sessionID") ?? "";

    let accepted = false;
    if (result.status === 200) {
      const fields = peekSoapResponseFields(decodeForwardBody(result), "ApplyModificationsBytesEx");
      accepted = text(fields, "ApplyModificationsBytesExResult") === "true";
      const stamp = parseStamp(text(fields, "newServerTimeStamp"));
      if (accepted && stamp !== undefined) this.stored.set(partition.key, stamp);
    }
    // A rejected or failed Apply resolves nothing: MLO retries in ~3 s from
    // unchanged stamps, and the pins keep re-delivery out of its way.
    if (!accepted) return;

    const encoded = text(requestFields, "data")?.replace(/\s+/g, "");
    if (!encoded) return;
    const bytes = Buffer.from(encoded, "base64");
    if (!isZipPayload(bytes)) return;
    const applied = harvestTaskRows(unpackEnvelope(bytes));
    const appliedByUid = new Map(applied.rows.map((row) => [row.uid, row]));
    const tombstoned = new Set(applied.tombstones);

    const now = this.now().toISOString();
    for (const write of await partition.queue.pending()) {
      // Only writes that have actually been injected are judged: an Apply
      // touching a merely-queued write's UID is MLO's own edit, and the queued
      // write is still current (real-time-writes charter).
      if (!this.inFlight.has(write.writeId)) continue;
      let verdict: "delivered" | "superseded" | undefined;
      let detail: string | undefined;
      if (write.verb === "delete") {
        if (tombstoned.has(write.uid)) verdict = "delivered";
        else if (appliedByUid.has(write.uid)) {
          verdict = "superseded";
          detail = "MLO uploaded a live row for a UID this write tombstoned — the user's row won";
        }
      } else {
        const appliedRow = appliedByUid.get(write.uid);
        if (appliedRow) {
          const injected = write.rows.find((row) => row.section === "TodoItems");
          const match = injected !== undefined &&
            rowsMatch({ header: TODO_ITEMS_HEADER, cells: injected.values }, appliedRow);
          verdict = match ? "delivered" : "superseded";
          if (!match) detail = "MLO uploaded a different row for this UID — a conflict resolved local-wins supersedes the write";
        } else if (tombstoned.has(write.uid)) {
          verdict = "superseded";
          detail = "MLO tombstoned the UID this write updated — the user's deletion won";
        }
      }
      if (!verdict) continue;
      const removed = await partition.resolveWrite(write.writeId, verdict, now, detail);
      if (!removed) continue;
      this.inFlight.delete(write.writeId);
      log(`write ${write.writeId} (${write.verb} ${write.uid}) ${verdict} via session ${session || "?"}`);
    }
  }

  /**
   * A released session is over: writes it carried but did not resolve are
   * unpinned, so the next Get re-delivers them (the safety net, spec
   * mechanic 8).
   */
  observeRelease(requestFields: Record<string, unknown>): void {
    const session = text(requestFields, "sessionID");
    if (!session) return;
    for (const [writeId, pin] of this.inFlight) {
      if (pin.session === session) this.inFlight.delete(writeId);
    }
  }

  /**
   * The GetFileTS nudge: an advanced answer only while the queue is
   * non-empty, undefined (forward verbatim) otherwise.
   */
  async nudgeFileTs(requestFields: Record<string, unknown>, result: ForwardResult): Promise<Uint8Array | undefined> {
    const partition = await this.boundPartition(text(requestFields, "dataFileUID"));
    if (!partition || result.status !== 200) return undefined;
    await this.expireDue(partition);
    if (!(await partition.queue.pending()).length) return undefined;
    const fields = peekSoapResponseFields(decodeForwardBody(result), GET_FILE_TS);
    const vendorTs = parseStamp(text(fields, `${GET_FILE_TS}Result`));
    if (vendorTs === undefined) return undefined;
    const advanced = nudgedFileTsVersion(vendorTs, this.stored.get(partition.key));
    if (advanced <= vendorTs) return undefined;
    log(`GetFileTS nudged for ${partition.uid}: ${vendorTs} -> ${advanced} (queue non-empty)`);
    return buildGetFileTsResponse(advanced.toString());
  }
}

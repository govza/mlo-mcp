import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic-file.js";
import { FileCaptureJournal, type CaptureJournal } from "./capture-journal.js";
import { FileInjectionQueue, type InjectionQueue, type QueuedWrite } from "./injection-queue.js";
import { FileRowStore, type RowStore } from "./row-store.js";
import { FileWriteOutcomes, type ResolvedWriteStatus, type WriteOutcome, type WriteOutcomeStore } from "./write-outcomes.js";
import type { WriteId, WriteReceipt } from "../repo/mlo-repository.js";

/**
 * Per-`dataFileUID` cloud state, reachable only through the PartitionStore
 * handle — its on-disk layout is private (spec section 4).
 *
 * The vendor protocol identifies each remote logical database with
 * `dataFileUID`; a compatible server must partition every piece of sync state
 * by it (docs/mlo/cloud-sync.md, compatible-server requirement 1). The live
 * incident that motivated this: an unpartitioned log accumulated a foreign
 * profile's full snapshot next to another profile's deltas, and only the
 * origin-echo filter kept it from being imported across profiles.
 */

export type PartitionMode = "local" | "upstream";
export type PartitionLifecycle = "uninitialized" | "bootstrap-required" | "ready";

const GUID_BODY = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** Uppercase braced canonical form; rejects anything not GUID-shaped. */
export function normalizeDataFileUid(raw: string): string {
  const body = raw.trim().replace(/^\{/, "").replace(/\}$/, "").toUpperCase();
  if (!GUID_BODY.test(body)) throw new Error(`invalid dataFileUID: "${raw}"`);
  return `{${body}}`;
}

/**
 * Directory key for a partition. Hashed rather than the raw GUID so state
 * paths neither leak the cloud-file identity nor depend on brace/case
 * handling in path-sensitive tooling.
 */
export function partitionKey(uid: string): string {
  return createHash("sha256").update(normalizeDataFileUid(uid), "utf8").digest("hex").slice(0, 16);
}

export interface PartitionMeta {
  dataFileUID: string;
  mode: PartitionMode;
  lifecycle: PartitionLifecycle;
  createdAt: string;
  /**
   * A human asked for a fresh full-history pull (AdminService.repull). The
   * request is persisted rather than sent: only the resident holds the vendor
   * contact, and its HTTP surface is closed (spec section 4), so a session asks
   * by leaving this behind and the resident services it on the next proxied
   * sync. Cleared when the pull lands; the binding is never touched.
   */
  repullRequestedAt?: string;
}

export interface PartitionSummary extends PartitionMeta {
  key: string;
}

/** A write that left the queue without landing — the two outcomes that lost their rows. */
export type DeadLetteredWrite = WriteOutcome & { status: "expired" | "superseded" };

/** What one partition's write path has outstanding, and what it lost (`writeGauge`). */
export interface PartitionWriteGauge {
  pendingWrites: number;
  /** Age of the oldest queued write; absent when the queue is empty. */
  oldestPendingAgeMs?: number;
  /** Newest first, capped by the caller's tail. */
  deadLetters: DeadLetteredWrite[];
}

/**
 * The per-cloud-file handle (the reshaped mirror, spec section 4): the row
 * store, the capture journal, and the injection queue live under it. It
 * mirrors nothing — reads come from the local export; what is held here is
 * what the write path structurally needs (latest full rows for authoring,
 * durable pending writes for injection) plus the gauge source. The small
 * binding / sightings / dead-letter stores sit beside it at the state root,
 * because they are keyed by profile or shared across partitions.
 */
export class PartitionStore {
  /** UID -> latest full captured TodoItems row (authoring source for update/complete). */
  readonly rows: RowStore;
  /** Timestamped capture outcomes — the gauge source, never a latch. */
  readonly journal: CaptureJournal;
  /** Durably accepted writes awaiting injection into a forwarded Get. */
  readonly queue: InjectionQueue;
  /** Writes that left the queue: delivered / superseded / expired receipts. */
  readonly outcomes: WriteOutcomeStore;

  constructor(
    readonly uid: string,
    readonly key: string,
    readonly dir: string,
  ) {
    this.rows = new FileRowStore(dir);
    this.journal = new FileCaptureJournal(dir);
    this.queue = new FileInjectionQueue(dir);
    this.outcomes = new FileWriteOutcomes(dir);
  }

  /**
   * What this partition's write path has outstanding and what it lost: the
   * queue depth with the oldest entry's age, and the writes that left the queue
   * without landing (expired or superseded), newest first and capped at `tail`.
   *
   * Derived here rather than by the caller because the queue and the outcome
   * ring are this handle's own state (spec section 4): a reader that walked them
   * itself would be reimplementing "what is outstanding" against a layout it is
   * not supposed to know.
   */
  async writeGauge(tail: number): Promise<PartitionWriteGauge> {
    const [pending, outcomes] = await Promise.all([this.queue.pending(), this.outcomes.all()]);
    const queuedAt = pending.map((write) => Date.parse(write.queuedAt)).filter((at) => !Number.isNaN(at));
    const oldest = queuedAt.length ? Math.min(...queuedAt) : undefined;
    return {
      pendingWrites: pending.length,
      ...(oldest !== undefined ? { oldestPendingAgeMs: Math.max(0, Date.now() - oldest) } : {}),
      deadLetters: outcomes
        .filter((outcome) => outcome.status === "expired" || outcome.status === "superseded")
        .slice(-tail)
        .reverse() as DeadLetteredWrite[],
    };
  }

  /**
   * Resolve one queued write: out of the queue and into the outcome ring as a
   * single move, so no observer ever sees a write that is both still pending
   * and already resolved. Returns what was removed; undefined means another
   * resolution got there first (the pair is idempotent per writeId).
   */
  async resolveWrite(
    writeId: WriteId,
    status: ResolvedWriteStatus,
    at: string,
    detail?: string,
  ): Promise<QueuedWrite | undefined> {
    const removed = await this.queue.remove(writeId);
    if (!removed) return undefined;
    await this.outcomes.record({
      writeId,
      uid: removed.uid,
      verb: removed.verb,
      ...(removed.caption ? { caption: removed.caption } : {}),
      status,
      at,
      ...(detail ? { detail } : {}),
    });
    return removed;
  }

  /**
   * The lazy TTL sweep: every due write leaves the queue for good as an
   * `expired` outcome. Returns what expired with the words recorded for it,
   * so the caller can dead-letter and unpin — those live outside this handle.
   */
  async expireDue(now: Date): Promise<{ write: QueuedWrite; detail: string }[]> {
    const expired: { write: QueuedWrite; detail: string }[] = [];
    for (const write of await this.queue.pending()) {
      const expiresAt = Date.parse(write.expiresAt);
      if (Number.isNaN(expiresAt) ? true : expiresAt > now.getTime()) continue;
      const detail = `write-expired: MLO did not apply the row before ${write.expiresAt}`;
      const removed = await this.resolveWrite(write.writeId, "expired", now.toISOString(), detail);
      if (removed) expired.push({ write: removed, detail });
    }
    return expired;
  }

  /**
   * One receipt's five-state answer, from the queue (still `accepted`) or the
   * outcome ring (resolved). Where a writeId lives inside a partition is this
   * handle's knowledge, not a caller's.
   */
  async findWrite(writeId: WriteId): Promise<WriteReceipt | undefined> {
    const queued = (await this.queue.pending()).find((write) => write.writeId === writeId);
    if (queued) {
      return {
        writeId,
        status: "accepted",
        uid: queued.uid,
        verb: queued.verb,
        ...(queued.caption ? { caption: queued.caption } : {}),
        expiresAt: queued.expiresAt,
      };
    }
    const outcome = await this.outcomes.byId(writeId);
    if (!outcome) return undefined;
    return {
      writeId,
      status: outcome.status,
      uid: outcome.uid,
      verb: outcome.verb,
      ...(outcome.caption ? { caption: outcome.caption } : {}),
      at: outcome.at,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
  }

  private metaPath(): string {
    return path.join(this.dir, "meta.json");
  }

  async meta(): Promise<PartitionMeta> {
    const parsed = JSON.parse(await fs.readFile(this.metaPath(), "utf8")) as PartitionMeta;
    return parsed;
  }

  async mode(): Promise<PartitionMode> {
    return (await this.meta()).mode;
  }

  async lifecycle(): Promise<PartitionLifecycle> {
    return (await this.meta()).lifecycle;
  }

  async setLifecycle(next: PartitionLifecycle): Promise<void> {
    await this.amendMeta({ lifecycle: next });
  }

  /** Ask the resident for a fresh full-history pull into the row store. */
  async requestRepull(at = new Date().toISOString()): Promise<void> {
    await this.amendMeta({ repullRequestedAt: at });
  }

  /** When a repull is outstanding; undefined when none is. */
  async repullRequestedAt(): Promise<string | undefined> {
    return (await this.meta()).repullRequestedAt;
  }

  async clearRepullRequest(): Promise<void> {
    // JSON.stringify drops an undefined member, so the key leaves the file.
    await this.amendMeta({ repullRequestedAt: undefined });
  }

  private async amendMeta(patch: Partial<PartitionMeta>): Promise<void> {
    const current = await this.meta();
    await atomicWrite(this.metaPath(), `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
  }
}

export class PartitionRegistry {
  private handles = new Map<string, PartitionStore>();

  constructor(readonly stateRoot: string) {}

  private partitionsDir(): string {
    return path.join(this.stateRoot, "partitions");
  }

  /**
   * Open a partition, creating its directory and meta on first use.
   * `createMode` labels a NEWLY created partition (from the binding or the
   * armed window that introduced it); an existing partition keeps its meta.
   */
  async open(rawUid: string, createMode: PartitionMode = "upstream"): Promise<PartitionStore> {
    const uid = normalizeDataFileUid(rawUid);
    const key = partitionKey(uid);
    const cached = this.handles.get(key);
    if (cached) return cached;
    const dir = path.join(this.partitionsDir(), key);
    await fs.mkdir(dir, { recursive: true });
    const handle = new PartitionStore(uid, key, dir);
    try {
      const meta = await handle.meta();
      if (normalizeDataFileUid(meta.dataFileUID) !== uid) {
        throw new Error(`partition key collision: ${dir} already belongs to a different dataFileUID`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const meta: PartitionMeta = {
        dataFileUID: uid,
        mode: createMode,
        lifecycle: "uninitialized",
        createdAt: new Date().toISOString(),
      };
      await atomicWrite(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    }
    this.handles.set(key, handle);
    return handle;
  }

  /** Resolve a partition only if it already exists on disk. */
  async resolveExisting(rawUid: string): Promise<PartitionStore | undefined> {
    const uid = normalizeDataFileUid(rawUid);
    const key = partitionKey(uid);
    const cached = this.handles.get(key);
    if (cached) return cached;
    const dir = path.join(this.partitionsDir(), key);
    try {
      await fs.stat(path.join(dir, "meta.json"));
    } catch {
      return undefined;
    }
    return this.open(uid);
  }

  /**
   * Delete a partition and everything in it — the effecting half of drift
   * recovery ([ADR-0007](../../../docs/adr/0007-recover-from-sync-drift-automatically.md)).
   *
   * Destructive by design: the queue inside it is discarded with the rest,
   * because a queue whose row store described a data file that no longer exists
   * is exactly what recovery exists to throw away. The cached handle goes first
   * so no live reference can recreate the directory behind the removal.
   */
  async discard(rawUid: string): Promise<void> {
    const uid = normalizeDataFileUid(rawUid);
    const key = partitionKey(uid);
    this.handles.delete(key);
    await fs.rm(path.join(this.partitionsDir(), key), { recursive: true, force: true });
  }

  async list(): Promise<PartitionSummary[]> {
    let keys: string[];
    try {
      keys = await fs.readdir(this.partitionsDir());
    } catch {
      return [];
    }
    const summaries: PartitionSummary[] = [];
    for (const key of keys.sort()) {
      try {
        const meta = JSON.parse(
          await fs.readFile(path.join(this.partitionsDir(), key, "meta.json"), "utf8"),
        ) as PartitionMeta;
        summaries.push({ key, ...meta });
      } catch {
        /* not a partition dir */
      }
    }
    return summaries;
  }
}

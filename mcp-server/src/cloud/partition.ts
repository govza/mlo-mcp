import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic-file.js";
import { FileCaptureJournal, type CaptureJournal } from "./capture-journal.js";
import { FileInjectionQueue, type InjectionQueue } from "./injection-queue.js";
import { FileRowStore, type RowStore } from "./row-store.js";

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
}

export interface PartitionSummary extends PartitionMeta {
  key: string;
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

  constructor(
    readonly uid: string,
    readonly key: string,
    readonly dir: string,
  ) {
    this.rows = new FileRowStore(dir);
    this.journal = new FileCaptureJournal(dir);
    this.queue = new FileInjectionQueue(dir);
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
    const current = await this.meta();
    await atomicWrite(this.metaPath(), `${JSON.stringify({ ...current, lifecycle: next }, null, 2)}\n`);
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

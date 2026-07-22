import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CloudState } from "./state.js";

/**
 * Per-`dataFileUID` cloud state.
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

async function atomicWrite(target: string, text: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(temporary, text);
  await fs.rename(temporary, target);
}

export class PartitionHandle {
  private cloudState?: CloudState;

  constructor(
    readonly uid: string,
    readonly key: string,
    readonly dir: string,
  ) {}

  /** Local-mode delta log; lives under `<partition>/local`. */
  get state(): CloudState {
    this.cloudState ??= new CloudState(path.join(this.dir, "local"));
    return this.cloudState;
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

  /** True when nothing was ever stored: no deltas, no pulls, no local stamp. */
  async isEmpty(): Promise<boolean> {
    const state = this.state;
    const [highWater, counts, lastPull] = await Promise.all([
      state.highWater(),
      state.counts(),
      state.lastPullCursor("app"),
    ]);
    return highWater === 0n && counts.mcp === 0 && counts.app === 0 && lastPull === 0n;
  }
}

export class PartitionRegistry {
  private handles = new Map<string, PartitionHandle>();

  constructor(
    readonly stateRoot: string,
    readonly defaultMode: PartitionMode,
  ) {}

  private partitionsDir(): string {
    return path.join(this.stateRoot, "partitions");
  }

  /** Open a partition, creating its directory and meta on first use. */
  async open(rawUid: string): Promise<PartitionHandle> {
    const uid = normalizeDataFileUid(rawUid);
    const key = partitionKey(uid);
    const cached = this.handles.get(key);
    if (cached) return cached;
    const dir = path.join(this.partitionsDir(), key);
    await fs.mkdir(dir, { recursive: true });
    const handle = new PartitionHandle(uid, key, dir);
    try {
      const meta = await handle.meta();
      if (normalizeDataFileUid(meta.dataFileUID) !== uid) {
        throw new Error(`partition key collision: ${dir} already belongs to a different dataFileUID`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const meta: PartitionMeta = {
        dataFileUID: uid,
        mode: this.defaultMode,
        lifecycle: "uninitialized",
        createdAt: new Date().toISOString(),
      };
      await atomicWrite(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    }
    this.handles.set(key, handle);
    return handle;
  }

  /** Resolve a partition only if it already exists on disk. */
  async resolveExisting(rawUid: string): Promise<PartitionHandle | undefined> {
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

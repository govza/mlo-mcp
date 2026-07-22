import { promises as fs } from "node:fs";
import path from "node:path";
import { cursorToDecimalString, parseCursor, ZERO_CURSOR, type CloudCursor } from "./cursor.js";
import { localStampToString, parseLocalStamp, type LocalStamp } from "./local-stamp.js";

export type DeltaOrigin = "mcp" | "app";

/**
 * A client presented a cursor from a different server history: its stored
 * remote baseline is ahead of this state's high water, but this state is
 * already initialized for that origin, so adopting the cursor would splice two
 * incompatible histories (observed live as duplicate-subtree imports after an
 * endpoint switch). Callers must surface this as an explicit protocol-level
 * failure, never rebase.
 */
export class EndpointMismatchError extends Error {
  constructor() {
    super("client cursor is newer than an initialized local cloud state");
    this.name = "EndpointMismatchError";
  }
}

export interface DeltaEntry {
  cursor: CloudCursor;
  origin: DeltaOrigin;
  file: string;
  bytes: Uint8Array;
}

interface StateIndexEntry { cursor: string; origin: DeltaOrigin; file: string }
interface StateFile {
  highWater: string;
  entries: StateIndexEntry[];
  /** Last cursor each origin accepted from a pull; makes "pending" counts real. */
  lastPull?: Partial<Record<DeltaOrigin, string>>;
  lastFinalized?: string;
  /** Last `lastSyncTimestamp` the app sent with an upload. Diagnostics only. */
  lastLocalStamp?: string;
  /** Times a client presented a cursor from a different server history. */
  endpointMismatches?: number;
}

export class CloudState {
  private cursor: CloudCursor = ZERO_CURSOR;
  private entries: StateIndexEntry[] = [];
  private lastPull: Partial<Record<DeltaOrigin, string>> = {};
  private lastFinalized?: string;
  private lastStamp?: string;
  private mismatches = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly stateDir: string) {}

  private async load(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    this.cursor = ZERO_CURSOR;
    this.entries = [];
    this.lastPull = {};
    this.lastFinalized = undefined;
    this.lastStamp = undefined;
    this.mismatches = 0;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.stateDir, "state.json"), "utf8")) as StateFile;
      this.cursor = parseCursor(parsed.highWater);
      this.entries = parsed.entries;
      this.lastPull = parsed.lastPull ?? {};
      this.lastFinalized = parsed.lastFinalized;
      this.lastStamp = parsed.lastLocalStamp;
      this.mismatches = parsed.endpointMismatches ?? 0;
      for (const entry of this.entries) parseCursor(entry.cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockDir = path.join(this.stateDir, ".state-lock");
    const deadline = Date.now() + 10_000;
    await fs.mkdir(this.stateDir, { recursive: true });
    for (;;) {
      try {
        await fs.mkdir(lockDir);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(lockDir);
          if (Date.now() - stat.mtimeMs > 30_000) {
            await fs.rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for cloud state lock: ${lockDir}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try { return await operation(); }
    finally { await fs.rm(lockDir, { recursive: true, force: true }); }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.withStateLock(async () => {
      await this.load();
      return operation();
    });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private read<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = async () => {
      await this.load();
      return operation();
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async append(origin: DeltaOrigin, zipBytes: Uint8Array): Promise<CloudCursor> {
    return this.serialize(async () => {
      let cursor = (this.cursor + 1n) as CloudCursor;
      let file = `delta-${cursorToDecimalString(cursor)}.zip`;
      while (await fs.stat(path.join(this.stateDir, file)).then(() => true, () => false)) {
        cursor = (cursor + 1n) as CloudCursor;
        file = `delta-${cursorToDecimalString(cursor)}.zip`;
      }
      await this.atomicWrite(path.join(this.stateDir, file), zipBytes);
      this.cursor = cursor;
      this.entries.push({ cursor: cursorToDecimalString(cursor), origin, file });
      await this.writeState();
      return cursor;
    });
  }

  /**
   * Append an entry at an EXTERNALLY assigned cursor (the vendor's remote
   * version, for mirror logs). Re-observing an already-recorded version is a
   * no-op; an older unseen version is ignored with `false` (vendor versions
   * are monotonic — a merged Get response already covered it).
   */
  async appendAtCursor(origin: DeltaOrigin, zipBytes: Uint8Array, cursor: CloudCursor): Promise<boolean> {
    return this.serialize(async () => {
      if (this.entries.some((entry) => parseCursor(entry.cursor) === cursor)) return false;
      if (cursor <= this.cursor) return false;
      const file = `delta-${cursorToDecimalString(cursor)}.zip`;
      await this.atomicWrite(path.join(this.stateDir, file), zipBytes);
      this.cursor = cursor;
      this.entries.push({ cursor: cursorToDecimalString(cursor), origin, file });
      await this.writeState();
      return true;
    });
  }

  async entriesAfter(cursor: CloudCursor, excludeOrigin?: DeltaOrigin): Promise<DeltaEntry[]> {
    return this.read(async () => {
      const selected = this.entries.filter((entry) => parseCursor(entry.cursor) > cursor && entry.origin !== excludeOrigin);
      return Promise.all(selected.map(async (entry) => ({
        cursor: parseCursor(entry.cursor),
        origin: entry.origin,
        file: entry.file,
        bytes: await fs.readFile(path.join(this.stateDir, entry.file)),
      })));
    });
  }

  async highWater(): Promise<CloudCursor> {
    return this.read(() => this.cursor);
  }

  /**
   * Adopt the cursor already stored by an MLO profile on its first local pull.
   *
   * A profile that previously used the vendor service can arrive with a cursor
   * far above a fresh local state's zero. Pending local entries must be moved
   * above that baseline or MLO will consider them old. Entry filenames are
   * intentionally left unchanged; the index is authoritative and this keeps
   * the rebase atomic with the state-file write.
   */
  async adoptInitialBaseline(origin: DeltaOrigin, baseline: CloudCursor): Promise<void> {
    await this.serialize(async () => {
      if (baseline <= this.cursor) return;
      if (this.lastPull[origin] !== undefined || this.entries.some((entry) => entry.origin === origin)) {
        throw new EndpointMismatchError();
      }
      for (const entry of this.entries) {
        entry.cursor = cursorToDecimalString((parseCursor(entry.cursor) + baseline) as CloudCursor);
      }
      this.cursor = (this.cursor + baseline) as CloudCursor;
      await this.writeState();
    });
  }

  /**
   * Record the opaque local baseline the app sent with an upload. The value is
   * kept for diagnostics only — it is a different counter namespace from the
   * cloud cursor and must never gate or rebase anything.
   */
  async recordLocalStamp(stamp: LocalStamp): Promise<void> {
    await this.serialize(async () => {
      const value = localStampToString(stamp);
      if (this.lastStamp === value) return;
      this.lastStamp = value;
      await this.writeState();
    });
  }

  async lastLocalStamp(): Promise<LocalStamp | undefined> {
    return this.read(() => (this.lastStamp === undefined ? undefined : parseLocalStamp(this.lastStamp)));
  }

  /** Count an endpoint-mismatch rejection (distinct from bootstrap-required). */
  async recordEndpointMismatch(): Promise<void> {
    await this.serialize(async () => {
      this.mismatches += 1;
      await this.writeState();
    });
  }

  async endpointMismatchCount(): Promise<number> {
    return this.read(() => this.mismatches);
  }

  /** Record the cursor an origin accepted from a pull (only ever advances). */
  async recordPull(origin: DeltaOrigin, cursor: CloudCursor): Promise<void> {
    await this.serialize(async () => {
      const previous = this.lastPull[origin];
      if (previous !== undefined && parseCursor(previous) >= cursor) return;
      this.lastPull[origin] = cursorToDecimalString(cursor);
      await this.writeState();
    });
  }

  async lastPullCursor(origin: DeltaOrigin): Promise<CloudCursor> {
    return this.read(() => {
      const value = this.lastPull[origin];
      return value === undefined ? ZERO_CURSOR : parseCursor(value);
    });
  }

  /** Entries authored by others that `origin` has not pulled yet. */
  async pendingFor(origin: DeltaOrigin): Promise<number> {
    return this.read(() => {
      const value = this.lastPull[origin];
      const cursor = value === undefined ? ZERO_CURSOR : parseCursor(value);
      return this.entries.filter((entry) => parseCursor(entry.cursor) > cursor && entry.origin !== origin).length;
    });
  }

  async counts(): Promise<{ mcp: number; app: number }> {
    return this.read(() => ({
      mcp: this.entries.filter((entry) => entry.origin === "mcp").length,
      app: this.entries.filter((entry) => entry.origin === "app").length,
    }));
  }

  async finalize(): Promise<void> {
    await this.serialize(async () => {
      this.lastFinalized = new Date().toISOString();
      await this.writeState();
    });
  }

  async flush(): Promise<void> {
    await this.serialize(() => this.writeState());
  }

  private async writeState(): Promise<void> {
    const value: StateFile = {
      highWater: cursorToDecimalString(this.cursor),
      entries: this.entries,
      ...(Object.keys(this.lastPull).length ? { lastPull: this.lastPull } : {}),
      ...(this.lastFinalized ? { lastFinalized: this.lastFinalized } : {}),
      ...(this.lastStamp !== undefined ? { lastLocalStamp: this.lastStamp } : {}),
      ...(this.mismatches ? { endpointMismatches: this.mismatches } : {}),
    };
    await this.atomicWrite(path.join(this.stateDir, "state.json"), new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
  }

  private async atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, target);
  }
}

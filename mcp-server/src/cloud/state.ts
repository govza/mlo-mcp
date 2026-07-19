import { promises as fs } from "node:fs";
import path from "node:path";
import { cursorToDecimalString, parseCursor, ZERO_CURSOR, type CloudCursor } from "./cursor.js";

export type DeltaOrigin = "mcp" | "app";

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
}

export class CloudState {
  private loaded?: Promise<void>;
  private cursor: CloudCursor = ZERO_CURSOR;
  private entries: StateIndexEntry[] = [];
  private lastPull: Partial<Record<DeltaOrigin, string>> = {};
  private lastFinalized?: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly stateDir: string) {}

  private ensureLoaded(): Promise<void> {
    return this.loaded ??= this.load();
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.stateDir, "state.json"), "utf8")) as StateFile;
      this.cursor = parseCursor(parsed.highWater);
      this.entries = parsed.entries;
      this.lastPull = parsed.lastPull ?? {};
      this.lastFinalized = parsed.lastFinalized;
      for (const entry of this.entries) parseCursor(entry.cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async append(origin: DeltaOrigin, zipBytes: Uint8Array): Promise<CloudCursor> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const cursor = (this.cursor + 1n) as CloudCursor;
      const file = `delta-${cursorToDecimalString(cursor)}.zip`;
      await this.atomicWrite(path.join(this.stateDir, file), zipBytes);
      this.cursor = cursor;
      this.entries.push({ cursor: cursorToDecimalString(cursor), origin, file });
      await this.writeState();
      return cursor;
    });
  }

  async entriesAfter(cursor: CloudCursor, excludeOrigin?: DeltaOrigin): Promise<DeltaEntry[]> {
    await this.ensureLoaded();
    const selected = this.entries.filter((entry) => parseCursor(entry.cursor) > cursor && entry.origin !== excludeOrigin);
    return Promise.all(selected.map(async (entry) => ({
      cursor: parseCursor(entry.cursor),
      origin: entry.origin,
      file: entry.file,
      bytes: await fs.readFile(path.join(this.stateDir, entry.file)),
    })));
  }

  async highWater(): Promise<CloudCursor> {
    await this.ensureLoaded();
    return this.cursor;
  }

  /** Record the cursor an origin accepted from a pull (only ever advances). */
  async recordPull(origin: DeltaOrigin, cursor: CloudCursor): Promise<void> {
    await this.serialize(async () => {
      await this.ensureLoaded();
      const previous = this.lastPull[origin];
      if (previous !== undefined && parseCursor(previous) >= cursor) return;
      this.lastPull[origin] = cursorToDecimalString(cursor);
      await this.writeState();
    });
  }

  async lastPullCursor(origin: DeltaOrigin): Promise<CloudCursor> {
    await this.ensureLoaded();
    const value = this.lastPull[origin];
    return value === undefined ? ZERO_CURSOR : parseCursor(value);
  }

  /** Entries authored by others that `origin` has not pulled yet. */
  async pendingFor(origin: DeltaOrigin): Promise<number> {
    return (await this.entriesAfter(await this.lastPullCursor(origin), origin)).length;
  }

  async counts(): Promise<{ mcp: number; app: number }> {
    await this.ensureLoaded();
    return {
      mcp: this.entries.filter((entry) => entry.origin === "mcp").length,
      app: this.entries.filter((entry) => entry.origin === "app").length,
    };
  }

  async finalize(): Promise<void> {
    await this.serialize(async () => {
      await this.ensureLoaded();
      this.lastFinalized = new Date().toISOString();
      await this.writeState();
    });
  }

  async flush(): Promise<void> {
    await this.chain;
    await this.ensureLoaded();
    await this.writeState();
  }

  private async writeState(): Promise<void> {
    const value: StateFile = {
      highWater: cursorToDecimalString(this.cursor),
      entries: this.entries,
      ...(Object.keys(this.lastPull).length ? { lastPull: this.lastPull } : {}),
      ...(this.lastFinalized ? { lastFinalized: this.lastFinalized } : {}),
    };
    await this.atomicWrite(path.join(this.stateDir, "state.json"), new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
  }

  private async atomicWrite(target: string, bytes: Uint8Array): Promise<void> {
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, target);
  }
}

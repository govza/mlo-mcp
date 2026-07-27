import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, WriteChain } from "./atomic-file.js";
import { findSection, type SectionedCsv } from "./csv.js";
import { normalizeGuid } from "./delta.js";

/**
 * UID -> the latest full TodoItems row seen in any captured payload.
 *
 * Update and complete structurally need the target's latest full 82-column row
 * (spec section 5, a live-prototype fact): a delta TodoItems row is a
 * full-record replacement, so authoring one from anything less silently resets
 * the columns it omits. The vendor never serves reads, so the only complete
 * source of rows is what has already passed through the proxy — the guarded
 * auto-init pull seeds this store once, passive capture keeps it current
 * forever after.
 *
 * Single writer: the resident process (capture tap and auto-init pull).
 * Attached MCP sessions only read, re-loading when the file changes on disk.
 */

/** Where a captured row came from — evidence, not behaviour. */
export type RowSource = "vendor-get" | "mlo-apply" | "injected" | "history-pull";

export interface CapturedRow {
  header: readonly string[];
  cells: readonly string[];
  capturedAt: string;
  source: RowSource;
}

/**
 * A UID the store has never seen. Op-refusal tier (spec section 6): the write
 * against it refuses, the next call is fresh, and the remedy names the one
 * observation that ends the condition — a repull refreshing the store from the
 * vendor history.
 */
export interface UnknownRowRefusal {
  kind: "unknown-row";
  uid: string;
  retryable: "after-user-action";
  remedy: "repull";
  detail: string;
}

export type RowLookup = ({ kind: "row" } & CapturedRow) | UnknownRowRefusal;

/** The one shape of the miss, shared by the file store and its fake. */
export function unknownRowRefusal(uid: string): UnknownRowRefusal {
  return {
    kind: "unknown-row",
    uid,
    retryable: "after-user-action",
    remedy: "repull",
    detail: `no captured row for ${uid} — the row store has a gap; repull refreshes it from the vendor history`,
  };
}

/**
 * The identity service's synchronous port: UID -> latest captured caption.
 * Answers from the last state loaded off disk and refreshes in the background,
 * so a miss is honestly "unconfirmed", never a blocking read.
 */
export interface RowStoreView {
  captionOf(uid: string): string | undefined;
}

/** A RowStoreView that knows nothing — every resolution reads unconfirmed. */
export const EMPTY_ROW_STORE_VIEW: RowStoreView = { captionOf: () => undefined };

export interface RowStore {
  /**
   * Upsert every full TodoItems row of `document` and drop every UID its
   * tombstone section deletes. Rows without a GUID-shaped UID are ignored.
   */
  ingest(document: SectionedCsv, source: RowSource): Promise<{ upserts: number; tombstones: number }>;
  /** Rebuild the store from one complete document — the repull/auto-init seed. */
  replaceAll(document: SectionedCsv, source: RowSource): Promise<{ upserts: number }>;
  /** The latest captured row, or the typed `unknown-row` refusal carrying `repull`. */
  latest(uid: string): Promise<RowLookup>;
  size(): Promise<number>;
  /** The synchronous view identity resolves against. */
  view(): RowStoreView;
}

function keyOf(uid: string): string | undefined {
  try {
    return normalizeGuid(uid);
  } catch {
    return undefined;
  }
}

export interface HarvestedRows {
  /** Full TodoItems rows by normalized UID, in document order. */
  rows: { uid: string; header: readonly string[]; cells: string[] }[];
  /** Normalized UIDs the document's tombstone section deletes. */
  tombstones: string[];
}

/**
 * The one reading of a sync document both the file store and its fake apply:
 * full TodoItems rows in, tombstoned UIDs out, non-GUID rows ignored.
 */
export function harvestTaskRows(document: SectionedCsv): HarvestedRows {
  const harvested: HarvestedRows = { rows: [], tombstones: [] };
  const tasks = findSection(document, "TodoItems");
  if (tasks) {
    const uidIndex = tasks.header.indexOf("UID");
    if (uidIndex >= 0) {
      for (const row of tasks.rows) {
        const uid = keyOf(row[uidIndex] ?? "");
        if (uid) harvested.rows.push({ uid, header: tasks.header, cells: [...row] });
      }
    }
  }
  const deleted = findSection(document, "TodoItems.Deleted");
  if (deleted) {
    const uidIndex = deleted.header.indexOf("TodoItemUID");
    if (uidIndex >= 0) {
      for (const row of deleted.rows) {
        const uid = keyOf(row[uidIndex] ?? "");
        if (uid) harvested.tombstones.push(uid);
      }
    }
  }
  return harvested;
}

interface StoredRow {
  /** Index into the deduplicated header table. */
  h: number;
  cells: string[];
  at: string;
  source: RowSource;
}

interface RowStoreFile {
  savedAt: string;
  headers: string[][];
  rows: Record<string, StoredRow>;
}

const FILE_NAME = "rows.json";

export class FileRowStore implements RowStore {
  private headers: string[][] = [];
  private rows = new Map<string, StoredRow>();
  private loadedMtime: number | undefined;
  private loaded = false;
  private readonly writes = new WriteChain();

  constructor(private readonly dir: string) {}

  private file(): string {
    return path.join(this.dir, FILE_NAME);
  }

  /** Re-read the file when it changed on disk (or was never loaded). */
  private async ensureFresh(): Promise<void> {
    let mtime: number | undefined;
    try {
      mtime = (await fs.stat(this.file())).mtimeMs;
    } catch {
      // absent: an empty store is the truth until something is captured
      this.loaded = true;
      return;
    }
    if (this.loaded && mtime === this.loadedMtime) return;
    const parsed = JSON.parse(await fs.readFile(this.file(), "utf8")) as RowStoreFile;
    this.headers = parsed.headers ?? [];
    this.rows = new Map(Object.entries(parsed.rows ?? {}));
    this.loadedMtime = mtime;
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const value: RowStoreFile = {
      savedAt: new Date().toISOString(),
      headers: this.headers,
      rows: Object.fromEntries(this.rows),
    };
    await atomicWrite(this.file(), JSON.stringify(value));
    this.loadedMtime = (await fs.stat(this.file())).mtimeMs;
  }

  private headerIndex(header: readonly string[]): number {
    const existing = this.headers.findIndex(
      (candidate) => candidate.length === header.length && candidate.every((column, i) => column === header[i]),
    );
    if (existing >= 0) return existing;
    this.headers.push([...header]);
    return this.headers.length - 1;
  }

  private applyDocument(document: SectionedCsv, source: RowSource): { upserts: number; tombstones: number } {
    const harvested = harvestTaskRows(document);
    const at = new Date().toISOString();
    for (const { uid, header, cells } of harvested.rows) {
      this.rows.set(uid, { h: this.headerIndex(header), cells, at, source });
    }
    let tombstones = 0;
    for (const uid of harvested.tombstones) {
      if (this.rows.delete(uid)) tombstones += 1;
    }
    return { upserts: harvested.rows.length, tombstones };
  }

  ingest(document: SectionedCsv, source: RowSource): Promise<{ upserts: number; tombstones: number }> {
    return this.writes.run(async () => {
      await this.ensureFresh();
      const counts = this.applyDocument(document, source);
      if (counts.upserts || counts.tombstones) await this.save();
      return counts;
    });
  }

  replaceAll(document: SectionedCsv, source: RowSource): Promise<{ upserts: number }> {
    return this.writes.run(async () => {
      this.headers = [];
      this.rows = new Map();
      const { upserts } = this.applyDocument(document, source);
      await this.save();
      this.loaded = true;
      return { upserts };
    });
  }

  async latest(uid: string): Promise<RowLookup> {
    const key = keyOf(uid);
    if (key) {
      await this.ensureFresh();
      const stored = this.rows.get(key);
      if (stored) {
        return {
          kind: "row",
          header: this.headers[stored.h] ?? [],
          cells: stored.cells,
          capturedAt: stored.at,
          source: stored.source,
        };
      }
    }
    return unknownRowRefusal(uid);
  }

  async size(): Promise<number> {
    await this.ensureFresh();
    return this.rows.size;
  }

  view(): RowStoreView {
    // Warm the state at creation, so a session wired at startup answers from
    // disk truth by its first resolution rather than its second.
    void this.ensureFresh().catch(() => undefined);
    return {
      captionOf: (uid: string): string | undefined => {
        // Answer from the loaded state and refresh behind the answer: the view
        // is a confidence signal, and "not seen yet" is the honest reading of
        // a store that has not caught up.
        void this.ensureFresh().catch(() => undefined);
        const key = keyOf(uid);
        const stored = key ? this.rows.get(key) : undefined;
        if (!stored) return undefined;
        const captionIndex = (this.headers[stored.h] ?? []).indexOf("Caption");
        return captionIndex >= 0 ? stored.cells[captionIndex] : undefined;
      },
    };
  }
}

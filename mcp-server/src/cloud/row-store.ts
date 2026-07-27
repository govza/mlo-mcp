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
  /**
   * The task's complete context relation set as of this row. MLO reads the
   * relation rows accompanying an emitted task as a REPLACEMENT set (removing
   * the last context is a TodoItems row with zero TodoItemPlaces rows — there
   * is no TodoItemPlaces.Deleted section), so authoring an update without them
   * silently clears the task's contexts. They travel with the row for the same
   * reason the row must be complete.
   */
  placeUids: readonly string[];
  /** Same replacement rule, for `TodoItems.Dependency`. */
  dependencyUids: readonly string[];
  /** The task's manual starred-order index, when it carried one. */
  starredOrderIndex?: string;
}

/**
 * The named entities a write must address by UID while the caller speaks
 * captions: contexts and flags. Deltas carry them only when they change, so
 * the store accumulates them across captures rather than replacing.
 */
export interface RowCatalog {
  places: { uid: string; caption: string }[];
  flags: { uid: string; caption: string }[];
  /** Highest manual starred-order index seen — the base for appending a newly starred task. */
  maxStarredOrderIndex: number;
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
  /** The accumulated context/flag catalog a write resolves captions against. */
  catalog(): Promise<RowCatalog>;
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

export interface HarvestedRow {
  uid: string;
  header: readonly string[];
  cells: string[];
  placeUids: string[];
  dependencyUids: string[];
  starredOrderIndex?: string;
}

export interface HarvestedRows {
  /** Full TodoItems rows by normalized UID, in document order. */
  rows: HarvestedRow[];
  /** Normalized UIDs the document's tombstone section deletes. */
  tombstones: string[];
  /** Named entities the document declares, upserted into the catalog. */
  places: { uid: string; caption: string }[];
  flags: { uid: string; caption: string }[];
  /** Named entities the document deletes. */
  deletedPlaces: string[];
  deletedFlags: string[];
}

/** Normalized UIDs of one keyed section column, in document order. */
function uidColumn(document: SectionedCsv, section: string, column: string): string[] {
  const found = findSection(document, section);
  if (!found) return [];
  const index = found.header.indexOf(column);
  if (index < 0) return [];
  const uids: string[] = [];
  for (const row of found.rows) {
    const uid = keyOf(row[index] ?? "");
    if (uid) uids.push(uid);
  }
  return uids;
}

/** `uid -> caption` pairs of a named-entity section (Places, Flags). */
function namedColumn(document: SectionedCsv, section: string): { uid: string; caption: string }[] {
  const found = findSection(document, section);
  if (!found) return [];
  const uidIndex = found.header.indexOf("UID");
  const captionIndex = found.header.indexOf("Caption");
  if (uidIndex < 0 || captionIndex < 0) return [];
  const named: { uid: string; caption: string }[] = [];
  for (const row of found.rows) {
    const uid = keyOf(row[uidIndex] ?? "");
    if (uid) named.push({ uid, caption: row[captionIndex] ?? "" });
  }
  return named;
}

/** `taskUid -> related uids`, grouped in document order. */
function relationIndex(document: SectionedCsv, section: string, from: string, to: string): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  const found = findSection(document, section);
  if (!found) return grouped;
  const fromIndex = found.header.indexOf(from);
  const toIndex = found.header.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return grouped;
  for (const row of found.rows) {
    const owner = keyOf(row[fromIndex] ?? "");
    const target = keyOf(row[toIndex] ?? "");
    if (!owner || !target) continue;
    const current = grouped.get(owner);
    if (current) current.push(target);
    else grouped.set(owner, [target]);
  }
  return grouped;
}

/**
 * The one reading of a sync document both the file store and its fake apply:
 * full TodoItems rows with their complete relation sets in, tombstoned UIDs
 * and named-entity changes out, non-GUID rows ignored.
 */
export function harvestTaskRows(document: SectionedCsv): HarvestedRows {
  const places = relationIndex(document, "TodoItemPlaces", "TodoItemUID", "PlaceUID");
  const dependencies = relationIndex(document, "TodoItems.Dependency", "TaskUID", "DependencyUID");
  const starred = new Map<string, string>();
  const starredSection = findSection(document, "TodoView.ManualOrdering.Starred");
  if (starredSection) {
    const uidIndex = starredSection.header.indexOf("UID");
    const orderIndex = starredSection.header.indexOf("ItemIndex");
    if (uidIndex >= 0 && orderIndex >= 0) {
      for (const row of starredSection.rows) {
        const uid = keyOf(row[uidIndex] ?? "");
        if (uid) starred.set(uid, row[orderIndex] ?? "");
      }
    }
  }
  const harvested: HarvestedRows = {
    rows: [],
    tombstones: uidColumn(document, "TodoItems.Deleted", "TodoItemUID"),
    places: namedColumn(document, "Places"),
    flags: namedColumn(document, "Flags"),
    deletedPlaces: uidColumn(document, "Places.Deleted", "PlaceUID"),
    deletedFlags: uidColumn(document, "Flags.Deleted", "FlagUID"),
  };
  const tasks = findSection(document, "TodoItems");
  if (tasks) {
    const uidIndex = tasks.header.indexOf("UID");
    if (uidIndex >= 0) {
      for (const row of tasks.rows) {
        const uid = keyOf(row[uidIndex] ?? "");
        if (!uid) continue;
        const starredOrderIndex = starred.get(uid);
        harvested.rows.push({
          uid,
          header: tasks.header,
          cells: [...row],
          // Absent relation rows for an emitted task mean "none", never
          // "unchanged" — the replacement rule, applied at capture time.
          placeUids: places.get(uid) ?? [],
          dependencyUids: dependencies.get(uid) ?? [],
          ...(starredOrderIndex !== undefined ? { starredOrderIndex } : {}),
        });
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
  // Short keys throughout: this file holds one entry per task in the profile.
  /** CapturedRow.placeUids */
  places?: string[];
  /** CapturedRow.dependencyUids */
  deps?: string[];
  /** CapturedRow.starredOrderIndex */
  star?: string;
}

interface RowStoreFile {
  savedAt: string;
  headers: string[][];
  rows: Record<string, StoredRow>;
  /** uid -> caption, accumulated across captures. */
  places?: Record<string, string>;
  flags?: Record<string, string>;
}

const FILE_NAME = "rows.json";

/**
 * Apply a document's named-entity changes to a catalog pair. The file store
 * and its fake share this for the same reason they share `harvestTaskRows`:
 * the reading and the applying are one rule, and a copy of either is a place
 * for the fake to drift.
 */
export function applyCatalog(
  catalog: { places: Map<string, string>; flags: Map<string, string> },
  harvested: HarvestedRows,
): number {
  for (const { uid, caption } of harvested.places) catalog.places.set(uid, caption);
  for (const { uid, caption } of harvested.flags) catalog.flags.set(uid, caption);
  for (const uid of harvested.deletedPlaces) catalog.places.delete(uid);
  for (const uid of harvested.deletedFlags) catalog.flags.delete(uid);
  return harvested.places.length + harvested.flags.length + harvested.deletedPlaces.length + harvested.deletedFlags.length;
}

/** Highest finite manual starred-order index among the captured rows; 0 when none carries one. */
export function maxStarredOrderIndex(indices: readonly (string | undefined)[]): number {
  const values = indices.map(Number).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : 0;
}

export class FileRowStore implements RowStore {
  private headers: string[][] = [];
  private rows = new Map<string, StoredRow>();
  private places = new Map<string, string>();
  private flags = new Map<string, string>();
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
    this.places = new Map(Object.entries(parsed.places ?? {}));
    this.flags = new Map(Object.entries(parsed.flags ?? {}));
    this.loadedMtime = mtime;
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const value: RowStoreFile = {
      savedAt: new Date().toISOString(),
      headers: this.headers,
      rows: Object.fromEntries(this.rows),
      places: Object.fromEntries(this.places),
      flags: Object.fromEntries(this.flags),
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

  private applyDocument(
    document: SectionedCsv,
    source: RowSource,
  ): { upserts: number; tombstones: number; named: number } {
    const harvested = harvestTaskRows(document);
    const at = new Date().toISOString();
    for (const { uid, header, cells, placeUids, dependencyUids, starredOrderIndex } of harvested.rows) {
      this.rows.set(uid, {
        h: this.headerIndex(header),
        cells,
        at,
        source,
        places: placeUids,
        deps: dependencyUids,
        ...(starredOrderIndex !== undefined ? { star: starredOrderIndex } : {}),
      });
    }
    const named = applyCatalog({ places: this.places, flags: this.flags }, harvested);
    let tombstones = 0;
    for (const uid of harvested.tombstones) {
      if (this.rows.delete(uid)) tombstones += 1;
    }
    return { upserts: harvested.rows.length, tombstones, named };
  }

  ingest(document: SectionedCsv, source: RowSource): Promise<{ upserts: number; tombstones: number }> {
    return this.writes.run(async () => {
      await this.ensureFresh();
      const { named, ...counts } = this.applyDocument(document, source);
      if (counts.upserts || counts.tombstones || named) await this.save();
      return counts;
    });
  }

  replaceAll(document: SectionedCsv, source: RowSource): Promise<{ upserts: number }> {
    return this.writes.run(async () => {
      // Built beside the live state and swapped in only once it is on disk: a
      // failing save must leave the store it could not replace, not an emptied
      // one that reads as a gap until the process restarts.
      const previous = { headers: this.headers, rows: this.rows, places: this.places, flags: this.flags };
      this.headers = [];
      this.rows = new Map();
      this.places = new Map();
      this.flags = new Map();
      let upserts: number;
      try {
        upserts = this.applyDocument(document, source).upserts;
        await this.save();
      } catch (error) {
        Object.assign(this, previous);
        throw error;
      }
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
          placeUids: stored.places ?? [],
          dependencyUids: stored.deps ?? [],
          ...(stored.star !== undefined ? { starredOrderIndex: stored.star } : {}),
        };
      }
    }
    return unknownRowRefusal(uid);
  }

  async catalog(): Promise<RowCatalog> {
    await this.ensureFresh();
    return {
      places: [...this.places].map(([uid, caption]) => ({ uid, caption })),
      flags: [...this.flags].map(([uid, caption]) => ({ uid, caption })),
      maxStarredOrderIndex: maxStarredOrderIndex([...this.rows.values()].map((row) => row.star)),
    };
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

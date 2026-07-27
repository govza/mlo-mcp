import type { SectionedCsv } from "../../src/cloud/csv.js";
import { normalizeGuid } from "../../src/cloud/guid.js";
import {
  applyCatalog,
  harvestTaskRows,
  maxStarredOrderIndex,
  unknownRowRefusal,
  type CapturedRow,
  type RowCatalog,
  type RowLookup,
  type RowSource,
  type RowStore,
  type RowStoreView,
} from "../../src/cloud/row-store.js";

/**
 * In-memory RowStore. Document reading (harvestTaskRows) and the miss shape
 * (unknownRowRefusal) are the REAL ones, shared with FileRowStore; only
 * persistence is faked away.
 */
export class FakeRowStore implements RowStore {
  private readonly rows = new Map<string, CapturedRow>();
  private readonly places = new Map<string, string>();
  private readonly flags = new Map<string, string>();

  /** Seed one row directly — the minimal header a caption lookup needs. */
  set(uid: string, caption: string): void {
    this.setRow(uid, ["UID", "Caption"], [normalizeGuid(uid), caption]);
  }

  setRow(
    uid: string,
    header: string[],
    cells: string[],
    relations: { placeUids?: string[]; dependencyUids?: string[]; starredOrderIndex?: string } = {},
  ): void {
    this.rows.set(normalizeGuid(uid), {
      header,
      cells,
      capturedAt: new Date().toISOString(),
      source: "vendor-get",
      placeUids: relations.placeUids ?? [],
      dependencyUids: relations.dependencyUids ?? [],
      ...(relations.starredOrderIndex !== undefined ? { starredOrderIndex: relations.starredOrderIndex } : {}),
    });
  }

  /** Seed a named context or flag the catalog can resolve a caption against. */
  setPlace(uid: string, caption: string): void {
    this.places.set(normalizeGuid(uid), caption);
  }

  setFlag(uid: string, caption: string): void {
    this.flags.set(normalizeGuid(uid), caption);
  }

  async ingest(document: SectionedCsv, source: RowSource): Promise<{ upserts: number; tombstones: number }> {
    const harvested = harvestTaskRows(document);
    const capturedAt = new Date().toISOString();
    for (const { uid, header, cells, placeUids, dependencyUids, starredOrderIndex } of harvested.rows) {
      this.rows.set(uid, {
        header: [...header],
        cells,
        capturedAt,
        source,
        placeUids,
        dependencyUids,
        ...(starredOrderIndex !== undefined ? { starredOrderIndex } : {}),
      });
    }
    applyCatalog({ places: this.places, flags: this.flags }, harvested);
    let tombstones = 0;
    for (const uid of harvested.tombstones) {
      if (this.rows.delete(uid)) tombstones += 1;
    }
    return { upserts: harvested.rows.length, tombstones };
  }

  async catalog(): Promise<RowCatalog> {
    return {
      places: [...this.places].map(([uid, caption]) => ({ uid, caption })),
      flags: [...this.flags].map(([uid, caption]) => ({ uid, caption })),
      maxStarredOrderIndex: maxStarredOrderIndex([...this.rows.values()].map((row) => row.starredOrderIndex)),
    };
  }

  async replaceAll(document: SectionedCsv, source: RowSource): Promise<{ upserts: number }> {
    this.rows.clear();
    this.places.clear();
    this.flags.clear();
    const { upserts } = await this.ingest(document, source);
    return { upserts };
  }

  async latest(uid: string): Promise<RowLookup> {
    const row = this.lookup(uid);
    return row ? { kind: "row", ...row } : unknownRowRefusal(uid);
  }

  async size(): Promise<number> {
    return this.rows.size;
  }

  view(): RowStoreView {
    return {
      captionOf: (uid: string): string | undefined => {
        const row = this.lookup(uid);
        if (!row) return undefined;
        const captionIndex = row.header.indexOf("Caption");
        return captionIndex >= 0 ? row.cells[captionIndex] : undefined;
      },
    };
  }

  private lookup(uid: string): CapturedRow | undefined {
    try {
      return this.rows.get(normalizeGuid(uid));
    } catch {
      return undefined;
    }
  }
}

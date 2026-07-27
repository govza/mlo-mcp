import type { SectionedCsv } from "../../src/cloud/csv.js";
import { normalizeGuid } from "../../src/cloud/delta.js";
import {
  harvestTaskRows,
  unknownRowRefusal,
  type CapturedRow,
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

  /** Seed one row directly — the minimal header a caption lookup needs. */
  set(uid: string, caption: string): void {
    this.setRow(uid, ["UID", "Caption"], [normalizeGuid(uid), caption]);
  }

  setRow(uid: string, header: string[], cells: string[]): void {
    this.rows.set(normalizeGuid(uid), {
      header,
      cells,
      capturedAt: new Date().toISOString(),
      source: "vendor-get",
    });
  }

  async ingest(document: SectionedCsv, source: RowSource): Promise<{ upserts: number; tombstones: number }> {
    const harvested = harvestTaskRows(document);
    const capturedAt = new Date().toISOString();
    for (const { uid, header, cells } of harvested.rows) {
      this.rows.set(uid, { header: [...header], cells, capturedAt, source });
    }
    let tombstones = 0;
    for (const uid of harvested.tombstones) {
      if (this.rows.delete(uid)) tombstones += 1;
    }
    return { upserts: harvested.rows.length, tombstones };
  }

  async replaceAll(document: SectionedCsv, source: RowSource): Promise<{ upserts: number }> {
    this.rows.clear();
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

import { findSection, type SectionedCsv } from "./csv.js";
import { mergeDeltas } from "./delta.js";
import { unpackEnvelope } from "./envelope.js";
import { ZERO_CURSOR } from "./cursor.js";
import type { CloudState } from "./state.js";

export interface KnownRow {
  header: string[];
  row: string[];
}

export function rowValue(known: KnownRow, column: string): string {
  const index = known.header.indexOf(column);
  return index < 0 ? "" : known.row[index] ?? "";
}

/** Latest full TodoItems row per uppercase braced UID, newest-last over the given deltas. */
export function latestFullRows(documents: readonly SectionedCsv[]): Map<string, KnownRow> {
  const merged = mergeDeltas(documents);
  const section = findSection(merged, "TodoItems")!;
  const uidIndex = section.header.indexOf("UID");
  const rows = new Map<string, KnownRow>();
  for (const row of section.rows) {
    const uid = (row[uidIndex] ?? "").toUpperCase();
    if (uid) rows.set(uid, { header: section.header, row });
  }
  return rows;
}

/**
 * Latest known full row per UID across the whole delta log, both origins.
 * This is the only safe source for authoring update deltas: the XML export
 * lacks CreatedDate/LastModified/ItemIndex/UID (mostly), recurrence
 * internals, reminders, and color coding, so a row projected from it would
 * blank those columns on MLO's full-record merge. Coverage therefore grows
 * with the log — a task is updatable once it was added by an MCP tool or
 * touched in MLO since the local endpoint took over.
 */
export async function knownFullRows(state: CloudState): Promise<Map<string, KnownRow>> {
  const entries = await state.entriesAfter(ZERO_CURSOR);
  return latestFullRows(entries.map((entry) => unpackEnvelope(entry.bytes)));
}

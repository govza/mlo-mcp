import path from "node:path";
import { findSection, type SectionedCsv } from "./csv.js";
import { mergeDeltas } from "./delta.js";
import { unpackEnvelope } from "./envelope.js";
import { ZERO_CURSOR } from "./cursor.js";
import { SnapshotStore } from "./snapshot-store.js";
import type { CloudState } from "./state.js";
import type { TaskNode } from "../types.js";

export interface KnownRow {
  header: string[];
  row: string[];
}

export interface NamedCloudObject {
  uid: string;
  caption: string;
}

export interface KnownCloudProjection {
  rows: Map<string, KnownRow>;
  placeUidsByTask: Map<string, string[]>;
  dependencyUidsByTask: Map<string, string[]>;
  places: NamedCloudObject[];
  flags: NamedCloudObject[];
  starredOrderByTask: Map<string, string>;
}

export function rowValue(known: KnownRow, column: string): string {
  const index = known.header.indexOf(column);
  return index < 0 ? "" : known.row[index] ?? "";
}

/** Resolve a Place/Flag caption (case-insensitive, must be unambiguous) to its UID. */
export function resolveNamed(caption: string, objects: readonly NamedCloudObject[], kind: string): string {
  const matches = objects.filter((object) => object.caption.toLocaleLowerCase() === caption.toLocaleLowerCase());
  if (matches.length === 0) throw new Error(`unknown ${kind} "${caption}" — use an existing ${kind}`);
  if (matches.length > 1) throw new Error(`ambiguous ${kind} "${caption}" — ${matches.length} definitions have that caption`);
  return matches[0]!.uid;
}

/** Resolve by caption/ParentUID path; duplicate sibling captions stay ambiguous. */
export function resolveTaskUid(task: TaskNode, rows: ReadonlyMap<string, KnownRow>): string | undefined {
  let parentUid = "";
  for (const caption of task.Path) {
    const matches = [...rows.entries()].filter(([, known]) =>
      rowValue(known, "ParentUID").toUpperCase() === parentUid && rowValue(known, "Caption") === caption
    );
    if (matches.length !== 1) return undefined;
    parentUid = matches[0]![0].toUpperCase();
  }
  return parentUid || undefined;
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
  return (await knownCloudProjection(state)).rows;
}

/** Latest task rows plus relation/lookup state needed to author lossless updates. */
export async function knownCloudProjection(state: CloudState): Promise<KnownCloudProjection> {
  // A materialized bootstrap snapshot (stored beside the log) is the baseline;
  // only entries newer than its version are merged on top. Logs without a
  // snapshot (legacy demo dirs) keep the original full re-merge.
  const snapshot = await new SnapshotStore(path.join(state.stateDir, "snapshot")).load();
  const entries = await state.entriesAfter(snapshot?.version ?? ZERO_CURSOR);
  const merged = mergeDeltas([
    ...(snapshot ? [snapshot.document] : []),
    ...entries.map((entry) => unpackEnvelope(entry.bytes)),
  ]);
  const rows = latestFullRows([merged]);
  const collectRelations = (sectionName: string, ownerColumn: string, valueColumn: string): Map<string, string[]> => {
    const section = findSection(merged, sectionName)!;
    const ownerIndex = section.header.indexOf(ownerColumn);
    const valueIndex = section.header.indexOf(valueColumn);
    const result = new Map<string, string[]>();
    for (const row of section.rows) {
      const owner = (row[ownerIndex] ?? "").toUpperCase();
      const value = (row[valueIndex] ?? "").toUpperCase();
      if (owner && value) result.set(owner, [...(result.get(owner) ?? []), value]);
    }
    return result;
  };
  const named = (sectionName: "Places" | "Flags"): NamedCloudObject[] => {
    const section = findSection(merged, sectionName)!;
    const uidIndex = section.header.indexOf("UID");
    const captionIndex = section.header.indexOf("Caption");
    return section.rows
      .map((row) => ({ uid: (row[uidIndex] ?? "").toUpperCase(), caption: row[captionIndex] ?? "" }))
      .filter(({ uid, caption }) => uid !== "" && caption !== "");
  };
  const order = findSection(merged, "TodoView.ManualOrdering.Starred")!;
  const orderUid = order.header.indexOf("UID");
  const orderIndex = order.header.indexOf("ItemIndex");
  return {
    rows,
    placeUidsByTask: collectRelations("TodoItemPlaces", "TodoItemUID", "PlaceUID"),
    dependencyUidsByTask: collectRelations("TodoItems.Dependency", "TaskUID", "DependencyUID"),
    places: named("Places"),
    flags: named("Flags"),
    starredOrderByTask: new Map(order.rows.map((row) => [
      (row[orderUid] ?? "").toUpperCase(), row[orderIndex] ?? "",
    ])),
  };
}

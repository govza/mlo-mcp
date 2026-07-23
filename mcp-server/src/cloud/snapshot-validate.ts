import { findSection, type SectionedCsv } from "./csv.js";
import { TODO_ITEMS_HEADER } from "./delta.js";

/**
 * Structural validation of a candidate full-snapshot upload before it may
 * become a partition's authoritative baseline. Derived from the verified
 * first-sync/re-synchronize captures: every task is a complete 82-column row,
 * relationships are explicit, a `Config` section is present, and historical
 * tombstones may accompany the live rows (the captured re-sync snapshot
 * carried 6). Anything that fails here leaves the partition un-bootstrapped —
 * a rejected bootstrap is always preferable to a lossy baseline.
 */
export interface SnapshotValidation {
  ok: boolean;
  errors: string[];
  stats: Record<string, number>;
}

const GUID = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/;

const CANONICAL_TASK_COLUMNS: readonly string[] = TODO_ITEMS_HEADER;

function normalizedGuid(value: string): string {
  return value.trim().toUpperCase();
}

export interface SnapshotValidationOptions {
  /**
   * The `Config` section separates a genuine full UPLOAD from an incremental
   * delta that happened to arrive while armed. A client-initiated pull from
   * remote version 0 is full by construction, so that path may waive it.
   */
  requireConfig?: boolean;
}

export function validateFullSnapshot(
  document: SectionedCsv,
  options: SnapshotValidationOptions = {},
): SnapshotValidation {
  const errors: string[] = [];
  const stats: Record<string, number> = {};

  const versions = findSection(document, "SysVersions");
  const fileVersion = versions?.rows[0]?.[versions.header.indexOf("FileVersion")];
  if (fileVersion !== "3") errors.push(`unsupported SysVersions.FileVersion "${fileVersion ?? "<missing>"}"`);

  const tasks = findSection(document, "TodoItems");
  if (!tasks) {
    return { ok: false, errors: ["snapshot has no TodoItems section"], stats };
  }

  // The exact captured 82-column header, in order. Unknown extra columns after
  // the canonical set are preserved data, not errors.
  const canonical = tasks.header.slice(0, CANONICAL_TASK_COLUMNS.length);
  if (canonical.join(",") !== CANONICAL_TASK_COLUMNS.join(",")) {
    const firstDiff = CANONICAL_TASK_COLUMNS.findIndex((column, index) => canonical[index] !== column);
    errors.push(
      `TodoItems header deviates from the supported 82-column layout at column ${firstDiff + 1} ` +
      `("${canonical[firstDiff] ?? "<missing>"}" instead of "${CANONICAL_TASK_COLUMNS[firstDiff]}")`,
    );
  }

  const uidIndex = tasks.header.indexOf("UID");
  const parentIndex = tasks.header.indexOf("ParentUID");
  const flagIndex = tasks.header.indexOf("FlagUID");
  const live = new Map<string, string>(); // UID -> ParentUID
  for (const [rowNumber, row] of tasks.rows.entries()) {
    if (row.length !== tasks.header.length) {
      errors.push(`TodoItems row ${rowNumber + 1} has ${row.length} cells, expected ${tasks.header.length}`);
      continue;
    }
    const uid = normalizedGuid(row[uidIndex] ?? "");
    if (!GUID.test(uid)) {
      errors.push(`TodoItems row ${rowNumber + 1} has an invalid UID "${row[uidIndex] ?? ""}"`);
      continue;
    }
    if (live.has(uid)) errors.push(`duplicate task UID ${uid}`);
    live.set(uid, normalizedGuid(row[parentIndex] ?? ""));
  }
  stats.tasks = live.size;
  if (live.size === 0) errors.push("snapshot contains no tasks — not a full upload");

  // Parents resolve and are acyclic.
  for (const [uid, parent] of live) {
    if (parent && !live.has(parent)) errors.push(`task ${uid} has unresolved ParentUID ${parent}`);
  }
  const visited = new Set<string>();
  for (const start of live.keys()) {
    if (visited.has(start)) continue;
    const chain = new Set<string>();
    let current: string | undefined = start;
    while (current && live.has(current) && !visited.has(current)) {
      if (chain.has(current)) {
        errors.push(`task parent cycle involving ${current}`);
        break;
      }
      chain.add(current);
      current = live.get(current) || undefined;
    }
    for (const uid of chain) visited.add(uid);
  }

  // Named-object sections: valid unique UIDs.
  const namedUids = (name: "Places" | "Flags"): Set<string> => {
    const section = findSection(document, name);
    const uids = new Set<string>();
    if (!section) {
      errors.push(`snapshot has no ${name} section`);
      return uids;
    }
    const index = section.header.indexOf("UID");
    for (const row of section.rows) {
      const uid = normalizedGuid(row[index] ?? "");
      if (!GUID.test(uid)) errors.push(`${name} row has an invalid UID "${row[index] ?? ""}"`);
      else if (uids.has(uid)) errors.push(`duplicate ${name} UID ${uid}`);
      else uids.add(uid);
    }
    return uids;
  };
  const places = namedUids("Places");
  const flags = namedUids("Flags");
  stats.places = places.size;
  stats.flags = flags.size;

  // Tombstones: unique, valid, and disjoint from live objects.
  const tombstones = (name: string, column: string, liveSet: ReadonlySet<string>): number => {
    const section = findSection(document, name);
    if (!section) return 0;
    const index = section.header.indexOf(column);
    const seen = new Set<string>();
    for (const row of section.rows) {
      const uid = normalizedGuid(row[index] ?? "");
      if (!GUID.test(uid)) errors.push(`${name} row has an invalid UID "${row[index] ?? ""}"`);
      else if (seen.has(uid)) errors.push(`duplicate tombstone ${uid} in ${name}`);
      else {
        seen.add(uid);
        if (liveSet.has(uid)) errors.push(`${name} tombstone ${uid} overlaps a live row`);
      }
    }
    return seen.size;
  };
  stats.taskTombstones = tombstones("TodoItems.Deleted", "TodoItemUID", new Set(live.keys()));
  stats.placeTombstones = tombstones("Places.Deleted", "PlaceUID", places);
  stats.flagTombstones = tombstones("Flags.Deleted", "FlagUID", flags);

  // References resolve: task contexts, flag assignments, dependencies,
  // starred ordering, and context hierarchy edges.
  const relations = (name: string, checks: { column: string; set: ReadonlySet<string>; what: string }[]): number => {
    const section = findSection(document, name);
    if (!section) return 0;
    for (const row of section.rows) {
      for (const { column, set, what } of checks) {
        const uid = normalizedGuid(row[section.header.indexOf(column)] ?? "");
        if (!set.has(uid)) errors.push(`${name} references ${what} ${uid || "<blank>"} that is not in the snapshot`);
      }
    }
    return section.rows.length;
  };
  const liveSet = new Set(live.keys());
  stats.taskPlaces = relations("TodoItemPlaces", [
    { column: "TodoItemUID", set: liveSet, what: "task" },
    { column: "PlaceUID", set: places, what: "context" },
  ]);
  stats.dependencies = relations("TodoItems.Dependency", [
    { column: "TaskUID", set: liveSet, what: "task" },
    { column: "DependencyUID", set: liveSet, what: "task" },
  ]);
  stats.starredOrder = relations("TodoView.ManualOrdering.Starred", [
    { column: "UID", set: liveSet, what: "task" },
  ]);
  stats.placeRelations = relations("PlaceRelations", [
    { column: "PlaceUID", set: places, what: "context" },
    { column: "ParentPlaceUID", set: places, what: "context" },
  ]);
  if (flagIndex >= 0) {
    for (const row of tasks.rows) {
      const flag = normalizedGuid(row[flagIndex] ?? "");
      if (flag && !flags.has(flag)) errors.push(`task ${normalizedGuid(row[uidIndex] ?? "")} references unknown flag ${flag}`);
    }
  }

  // Both captured complete uploads carried a Config section; ordinary
  // incremental deltas never did. Its presence separates a genuine full
  // upload from a small delta that happened to arrive while armed.
  const config = findSection(document, "Config");
  if (!config && options.requireConfig !== false) {
    errors.push("snapshot has no Config section — this looks like an ordinary incremental delta, not a full upload");
  }
  if (config) stats.configRows = config.rows.length;

  return { ok: errors.length === 0, errors, stats };
}

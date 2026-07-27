import { findSection, type CsvSection, type SectionedCsv } from "./csv.js";
import { createDeltaSkeleton, SECTION_HEADERS } from "./mlo-schema.js";

/**
 * The delta merge engine: fold a sequence of delta documents into the one
 * document their combined effect implies, applying MLO's replacement rules for
 * relation sets and deletions.
 */

const KEYS: Record<string, string[]> = {
  Places: ["UID"],
  PlaceRelations: ["PlaceUID", "ParentPlaceUID"],
  "Places.Deleted": ["PlaceUID"],
  Flags: ["UID"],
  "Flags.Deleted": ["FlagUID"],
  TodoItems: ["UID"],
  TodoItemPlaces: ["TodoItemUID", "PlaceUID"],
  "TodoItems.Dependency": ["TaskUID", "DependencyUID"],
  "TodoItems.Deleted": ["TodoItemUID"],
  "TodoView.ManualOrdering.Starred": ["UID"],
};

function rowKey(section: CsvSection, row: string[], columns: string[]): string {
  return columns.map((column) => row[section.header.indexOf(column)] ?? "").join("\u0000");
}

export function mergeDeltas(entries: readonly SectionedCsv[]): SectionedCsv {
  const result = createDeltaSkeleton();
  const knownNames = new Set<string>(SECTION_HEADERS.map(([name]) => name));
  const targets = new Map(result.sections.map((section) => [section.name, section]));
  for (const document of entries) {
    for (const section of document.sections) {
      const target = targets.get(section.name);
      if (!target) continue;
      for (const column of section.header) if (!target.header.includes(column)) target.header.push(column);
    }
  }
  const maps = new Map<string, Map<string, string[]>>();
  for (const [name] of SECTION_HEADERS) maps.set(name, new Map());
  const unknown = new Map<string, CsvSection>();

  for (const document of entries) {
    // App captures show that relation rows belonging to each emitted task are
    // a complete replacement set. In particular, removing the last context is
    // encoded as a TodoItems row and zero TodoItemPlaces rows (there is no
    // TodoItemPlaces.Deleted section). Apply that replacement rule before
    // consuming the document's current relation rows.
    const taskSection = findSection(document, "TodoItems");
    const deletedSection = findSection(document, "TodoItems.Deleted");
    const changedUids = new Set<string>();
    const deletedUids = new Set<string>();
    if (taskSection) {
      const uidIndex = taskSection.header.indexOf("UID");
      for (const row of taskSection.rows) changedUids.add((row[uidIndex] ?? "").toUpperCase());
    }
    if (deletedSection) {
      const uidIndex = deletedSection.header.indexOf("TodoItemUID");
      for (const row of deletedSection.rows) deletedUids.add((row[uidIndex] ?? "").toUpperCase());
    }
    const purgeRelations = (sectionName: "TodoItemPlaces" | "TodoItems.Dependency", uids: Set<string>) => {
      const map = maps.get(sectionName)!;
      for (const key of [...map.keys()]) if (uids.has(key.split("\u0000", 1)[0]!.toUpperCase())) map.delete(key);
    };
    purgeRelations("TodoItemPlaces", changedUids);
    purgeRelations("TodoItems.Dependency", changedUids);
    purgeRelations("TodoItemPlaces", deletedUids);
    purgeRelations("TodoItems.Dependency", deletedUids);
    const starredOrder = maps.get("TodoView.ManualOrdering.Starred")!;
    for (const uid of deletedUids) starredOrder.delete(uid);
    if (taskSection) {
      const uidIndex = taskSection.header.indexOf("UID");
      const starredIndex = taskSection.header.indexOf("Starred");
      if (starredIndex >= 0) {
        for (const row of taskSection.rows) {
          if ((row[starredIndex] ?? "") === "0") starredOrder.delete((row[uidIndex] ?? "").toUpperCase());
        }
      }
    }
    for (const section of document.sections) {
      if (section.name === "SysVersions") continue;
      if (!knownNames.has(section.name)) {
        const target = unknown.get(section.name);
        if (target) {
          for (const column of section.header) {
            if (!target.header.includes(column)) {
              target.header.push(column);
              for (const row of target.rows) row.push("");
            }
          }
          target.rows.push(...section.rows.map((row) => target.header.map((column) => {
            const index = section.header.indexOf(column);
            return index < 0 ? "" : row[index] ?? "";
          })));
        } else unknown.set(section.name, { name: section.name, header: [...section.header], rows: section.rows.map((row) => [...row]) });
        continue;
      }
      const keys = KEYS[section.name];
      if (!keys) continue;
      const map = maps.get(section.name)!;
      for (const row of section.rows) {
        const key = rowKey(section, row, keys);
        if ((section.name === "TodoItemPlaces" || section.name === "TodoItems.Dependency") &&
            deletedUids.has((row[0] ?? "").toUpperCase())) continue;
        const targetHeader = targets.get(section.name)!.header;
        const projected = targetHeader.map((column) => {
          const index = section.header.indexOf(column);
          return index < 0 ? "" : row[index] ?? "";
        });
        map.set(key, projected);
        if (section.name === "TodoItems.Deleted") maps.get("TodoItems")!.delete(key);
        if (section.name === "Places.Deleted") maps.get("Places")!.delete(key);
        if (section.name === "Flags.Deleted") maps.get("Flags")!.delete(key);
      }
    }
  }
  for (const section of result.sections) {
    if (section.name !== "SysVersions") section.rows = [...(maps.get(section.name)?.values() ?? [])];
  }
  result.sections.push(...unknown.values());
  return result;
}

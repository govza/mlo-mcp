import { randomUUID } from "node:crypto";
import { findSection, type CsvSection, type SectionedCsv } from "./csv.js";

export const FILE_VERSION = "3";
export const PROGRAM_VERSION = "6.1.3";
export const EDITION = "MLO-Windows";

export const TODO_ITEMS_HEADER = "UID,ParentUID,ItemIndex,Caption,Importance,Urgency,HideInToDo,HideInToDoThisTask,ScheduleType,CompletionDateTime,DueDateTime,StartDateTime,EstimateMin,EstimateMax,NextReviewDate,LastReviewed,ReviewEvery,ReviewRecurrenceType,CompleteInOrder,Effort,IsProject,ProjectStatus,DependOper,DependPostpone,CreatedDate,LastModified,TextTag,RecType,RecStartDate,RecEndDate,RecOccurrences,RecInterval,RecInstance,RecDOWMask,RecDayOfMonth,RecMonthOfYear,RecUseCompletionDate,RecUncompleteSubtasks,RecGeneratedCount,RecUncomplIfCompl,RecHourDelta,RecDNCCCopy,RecRecurWSC,GoalFor,FlagUID,Starred,StarToggleDateTime,ccUseCustomColorCoding,ccFont,ccSize,ccBold,ccItalic,ccUnderline,ccStrikethrough,ccFontColor,ccHighlightColor,ccChildrenIheritColorCoding,ccUnderlineColor,ccSideBarColor,ccBackgroundColor1_1,ccBackgroundColor1_2,ccBackgroundColor2_1,ccBackgroundColor2_2,ccUnderlineEntireRowColor,ccUnderlineEntireRowthickness,ccUnderlineDotted,ccBackgroundGradientToCenter,ccIndentRowLineAndBackground,Reminder,NextAlert,AutoAlert,AutoAlertDelta,LimitAutoAlertCount,MaxAutoAlertCount,AutoAlertIndex,ReminderState,AlertAction,Email,AppPath,AudioFile,PPCAudioFile,Note".split(",");

export const SECTION_HEADERS = [
  ["SysVersions", ["FileVersion", "ProgramVersion", "Edition"]],
  ["Places", ["UID", "Caption", "HideFromTodo", "HideFromItemProps", "Hotkey", "Latitude", "Longitude", "Radius", "NotifyWhenArrive", "NotifyWhenLeave", "OpenHours", "Note"]],
  ["PlaceRelations", ["PlaceUID", "ParentPlaceUID"]],
  ["Places.Deleted", ["PlaceUID"]],
  ["Flags", ["UID", "Caption", "HideInSelector", "Index", "Shortcut", "Icon"]],
  ["Flags.Deleted", ["FlagUID"]],
  ["TodoItems", TODO_ITEMS_HEADER],
  ["TodoItemPlaces", ["TodoItemUID", "PlaceUID"]],
  ["TodoItems.Dependency", ["TaskUID", "DependencyUID"]],
  ["TodoItems.Deleted", ["TodoItemUID"]],
  ["TodoView.ManualOrdering.Starred", ["UID", "ItemIndex"]],
] as const;

/** Canonical values emitted by MLO 6.1.3 for a new plain root task. */
export const NEW_TASK_DEFAULTS: Readonly<Record<string, string>> = {
  ItemIndex: "100",
  Importance: "100",
  Urgency: "100",
  HideInToDo: "0",
  HideInToDoThisTask: "0",
  ScheduleType: "0",
  EstimateMin: "0",
  EstimateMax: "0",
  ReviewEvery: "1",
  ReviewRecurrenceType: "1",
  CompleteInOrder: "0",
  Effort: "50",
  IsProject: "0",
  ProjectStatus: "0",
  DependOper: "0",
  DependPostpone: "0",
  GoalFor: "0",
  Starred: "0",
  ccUseCustomColorCoding: "0",
};

export function createDeltaSkeleton(): SectionedCsv {
  return {
    sections: SECTION_HEADERS.map(([name, header]) => ({
      name,
      header: [...header],
      rows: name === "SysVersions" ? [[FILE_VERSION, PROGRAM_VERSION, EDITION]] : [],
    })),
  };
}

export function normalizeGuid(uid: string): string {
  const raw = uid.replace(/^\{/, "").replace(/\}$/, "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error(`invalid GUID: "${uid}"`);
  }
  return `{${raw.toUpperCase()}}`;
}

export function generateGuid(): string {
  return `{${randomUUID().toUpperCase()}}`;
}

export interface TaskAddDeltaInput {
  uid: string;
  parentUid?: string;
  itemIndex?: string;
  caption: string;
  note?: string;
  dueDateTime?: string;
  startDateTime?: string;
  createdDate: string;
  lastModified: string;
  isProject?: boolean;
  starred?: boolean;
  hideInToDo?: boolean;
  hideInToDoThisTask?: boolean;
  completeInOrder?: boolean;
  flagUid?: string;
  placeUids?: readonly string[];
  dependencyUids?: readonly string[];
  starredOrderIndex?: string;
}

export function buildTaskAddDelta(input: TaskAddDeltaInput): SectionedCsv {
  const document = createDeltaSkeleton();
  const row = Array<string>(TODO_ITEMS_HEADER.length).fill("");
  const set = (column: string, value?: string) => { if (value !== undefined) row[TODO_ITEMS_HEADER.indexOf(column)] = value; };
  for (const [column, value] of Object.entries(NEW_TASK_DEFAULTS)) set(column, value);
  set("UID", normalizeGuid(input.uid));
  set("ParentUID", input.parentUid ? normalizeGuid(input.parentUid) : "");
  set("ItemIndex", input.itemIndex ?? NEW_TASK_DEFAULTS.ItemIndex);
  set("Caption", input.caption);
  set("DueDateTime", input.dueDateTime);
  set("StartDateTime", input.startDateTime);
  if (input.dueDateTime || input.startDateTime) set("ScheduleType", "1");
  set("CreatedDate", input.createdDate);
  set("LastModified", input.lastModified);
  set("Note", input.note);
  if (input.isProject !== undefined) set("IsProject", input.isProject ? "1" : "0");
  if (input.starred !== undefined) {
    set("Starred", input.starred ? "1" : "0");
    if (input.starred) set("StarToggleDateTime", input.lastModified);
  }
  if (input.hideInToDo !== undefined) set("HideInToDo", input.hideInToDo ? "1" : "0");
  if (input.hideInToDoThisTask !== undefined) set("HideInToDoThisTask", input.hideInToDoThisTask ? "1" : "0");
  if (input.completeInOrder !== undefined) set("CompleteInOrder", input.completeInOrder ? "1" : "0");
  if (input.flagUid !== undefined) set("FlagUID", input.flagUid ? normalizeGuid(input.flagUid) : "");
  findSection(document, "TodoItems")!.rows.push(row);
  for (const placeUid of input.placeUids ?? []) {
    findSection(document, "TodoItemPlaces")!.rows.push([normalizeGuid(input.uid), normalizeGuid(placeUid)]);
  }
  for (const dependencyUid of input.dependencyUids ?? []) {
    findSection(document, "TodoItems.Dependency")!.rows.push([
      normalizeGuid(input.uid), normalizeGuid(dependencyUid),
    ]);
  }
  if (input.starred && input.starredOrderIndex) {
    findSection(document, "TodoView.ManualOrdering.Starred")!.rows.push([
      normalizeGuid(input.uid), input.starredOrderIndex,
    ]);
  }
  return document;
}

export function buildTaskDeleteDelta(uids: readonly string[]): SectionedCsv {
  const document = createDeltaSkeleton();
  const section = findSection(document, "TodoItems.Deleted")!;
  for (const uid of uids) section.rows.push([normalizeGuid(uid)]);
  return document;
}

export interface TaskRowUpdate {
  header: readonly string[];
  row: readonly string[];
  patch: Readonly<Record<string, string>>;
  /** Complete current relation sets. MLO treats relations for an emitted task as replacement sets. */
  placeUids?: readonly string[];
  dependencyUids?: readonly string[];
  /** Present only when this update explicitly adds/retains a starred ordering row. */
  starredOrderIndex?: string;
}

/**
 * Project known full rows with column patches into one update delta. The
 * source rows must be complete records (latest log row per UID) — MLO merges
 * a TodoItems row as a full-record replacement, so any column missing from
 * the source becomes a blank value in the profile.
 */
export function buildTaskUpdatesDelta(updates: readonly TaskRowUpdate[]): SectionedCsv {
  const document = createDeltaSkeleton();
  const section = findSection(document, "TodoItems")!;
  for (const update of updates) {
    for (const column of update.header) if (!section.header.includes(column)) section.header.push(column);
  }
  for (const update of updates) {
    const row = section.header.map((column) => {
      const index = update.header.indexOf(column);
      return index < 0 ? "" : update.row[index] ?? "";
    });
    for (const [column, value] of Object.entries(update.patch)) {
      const index = section.header.indexOf(column);
      if (index < 0) throw new Error(`unknown TodoItems column "${column}"`);
      row[index] = value;
    }
    section.rows.push(row);
    const uid = normalizeGuid(row[section.header.indexOf("UID")] ?? "");
    for (const placeUid of update.placeUids ?? []) {
      findSection(document, "TodoItemPlaces")!.rows.push([uid, normalizeGuid(placeUid)]);
    }
    for (const dependencyUid of update.dependencyUids ?? []) {
      findSection(document, "TodoItems.Dependency")!.rows.push([uid, normalizeGuid(dependencyUid)]);
    }
    if (update.starredOrderIndex !== undefined) {
      findSection(document, "TodoView.ManualOrdering.Starred")!.rows.push([uid, update.starredOrderIndex]);
    }
  }
  return document;
}

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

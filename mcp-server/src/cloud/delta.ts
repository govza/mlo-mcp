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
  caption: string;
  note?: string;
  dueDateTime?: string;
  startDateTime?: string;
  createdDate: string;
  lastModified: string;
}

export function buildTaskAddDelta(input: TaskAddDeltaInput): SectionedCsv {
  const document = createDeltaSkeleton();
  const row = Array<string>(TODO_ITEMS_HEADER.length).fill("");
  const set = (column: string, value?: string) => { if (value !== undefined) row[TODO_ITEMS_HEADER.indexOf(column)] = value; };
  set("UID", normalizeGuid(input.uid));
  set("ParentUID", input.parentUid ? normalizeGuid(input.parentUid) : "");
  set("Caption", input.caption);
  set("DueDateTime", input.dueDateTime);
  set("StartDateTime", input.startDateTime);
  set("CreatedDate", input.createdDate);
  set("LastModified", input.lastModified);
  set("Note", input.note);
  findSection(document, "TodoItems")!.rows.push(row);
  return document;
}

export function buildTaskDeleteDelta(uid: string): SectionedCsv {
  const document = createDeltaSkeleton();
  findSection(document, "TodoItems.Deleted")!.rows.push([normalizeGuid(uid)]);
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
        const targetHeader = targets.get(section.name)!.header;
        const projected = targetHeader.map((column) => {
          const index = section.header.indexOf(column);
          return index < 0 ? "" : row[index] ?? "";
        });
        map.set(key, projected);
        if (section.name === "TodoItems.Deleted") maps.get("TodoItems")!.delete(key);
      }
    }
  }
  for (const section of result.sections) {
    if (section.name !== "SysVersions") section.rows = [...(maps.get(section.name)?.values() ?? [])];
  }
  result.sections.push(...unknown.values());
  return result;
}

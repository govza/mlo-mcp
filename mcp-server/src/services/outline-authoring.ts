import type { CapturedRow } from "../cloud/row-store.js";

/**
 * The pure half of OutlineService's write policy: reading a captured row,
 * turning a caller's patch into column values, and placing a task among its
 * siblings. No I/O, no repository, no vendor protocol — so the rules that make
 * a write sensible are unit-testable without a fake in sight.
 */

/** CSV booleans in observed rows are numeric strings; anything non-empty and non-"0" is true. */
export function csvTruthy(value: string): boolean {
  return value !== "" && value !== "0";
}

export function rowValue(row: CapturedRow, column: string): string {
  const index = row.header.indexOf(column);
  return index < 0 ? "" : row.cells[index] ?? "";
}

/** Local time in MLO's own serialization — the app stores naive local timestamps. */
export function nowIso(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * What one update may change. Only provided fields change; `""` clears a text
 * field. `Places` and `dependsOnIds` are COMPLETE replacement sets, because
 * that is how MLO merges relation rows — there is no per-relation delete.
 */
export interface TaskPatch {
  Caption?: string;
  Note?: string;
  Importance?: number;
  Effort?: number;
  DueDateTime?: string;
  StartDateTime?: string;
  CompletionDateTime?: string;
  ProjectStatus?: number;
  EstimateMin?: number;
  EstimateMax?: number;
  TheGoal?: number;
  IsProject?: boolean;
  Starred?: boolean;
  /** Hide only this task from To-Do views; children stay eligible. */
  Folder?: boolean;
  HideInToDo?: boolean;
  CompleteSubTasksInOrder?: boolean;
  /** Existing flag caption; `""` clears. */
  Flag?: string;
  /** Complete replacement set of existing context captions; `[]` clears. */
  Places?: string[];
  /** Complete replacement set of path ids this task waits for; `[]` clears. */
  dependsOnIds?: string[];
}

const STRING_COLUMNS = ["Caption", "Note", "DueDateTime", "StartDateTime", "CompletionDateTime"] as const;
const NUMBER_COLUMNS: ReadonlyArray<readonly [keyof TaskPatch, string]> = [
  ["Importance", "Importance"],
  ["Effort", "Effort"],
  ["ProjectStatus", "ProjectStatus"],
  ["EstimateMin", "EstimateMin"],
  ["EstimateMax", "EstimateMax"],
  ["TheGoal", "GoalFor"],
];
const BOOLEAN_COLUMNS: ReadonlyArray<readonly [keyof TaskPatch, string]> = [
  ["IsProject", "IsProject"],
  ["Starred", "Starred"],
  ["Folder", "HideInToDoThisTask"],
  ["HideInToDo", "HideInToDo"],
  ["CompleteSubTasksInOrder", "CompleteInOrder"],
];

export interface MoveDestination {
  /** Empty string re-parents to the top level. */
  parentUid: string;
  /** The sibling slot the task takes; absent leaves ItemIndex untouched. */
  itemIndex?: string;
}

/** Column values an update writes over the captured row. */
export function updatePatch(
  patch: TaskPatch,
  row: CapturedRow,
  now: string,
  move?: MoveDestination,
  flagUid?: string,
): Record<string, string> {
  const columns: Record<string, string> = { LastModified: now };
  for (const column of STRING_COLUMNS) {
    const value = patch[column];
    if (value !== undefined) columns[column] = value;
  }
  for (const [field, column] of NUMBER_COLUMNS) {
    const value = patch[field];
    if (value !== undefined) columns[column] = String(value);
  }
  for (const [field, column] of BOOLEAN_COLUMNS) {
    const value = patch[field];
    if (typeof value === "boolean") columns[column] = value ? "1" : "0";
  }
  if (patch.Starred !== undefined && csvTruthy(rowValue(row, "Starred")) !== patch.Starred) {
    columns.StarToggleDateTime = now;
  }
  if (patch.Flag !== undefined) columns.FlagUID = flagUid ?? "";
  if (move) {
    columns.ParentUID = move.parentUid;
    if (move.itemIndex !== undefined) columns.ItemIndex = move.itemIndex;
  }
  if (patch.DueDateTime !== undefined || patch.StartDateTime !== undefined) {
    const due = patch.DueDateTime ?? rowValue(row, "DueDateTime");
    const start = patch.StartDateTime ?? rowValue(row, "StartDateTime");
    // Dates need ScheduleType 1; both cleared → back to 0. Nonzero values
    // other than 1 are left alone — their semantics are unobserved.
    if (due === "" && start === "") columns.ScheduleType = "0";
    else if (!csvTruthy(rowValue(row, "ScheduleType"))) columns.ScheduleType = "1";
  }
  return columns;
}

export function completionPatch(row: CapturedRow, now: string): Record<string, string> {
  return {
    CompletionDateTime: now,
    LastModified: now,
    ...(csvTruthy(rowValue(row, "IsProject")) ? { ProjectStatus: "3" } : {}),
  };
}

export function reopenPatch(row: CapturedRow, now: string): Record<string, string> {
  return {
    CompletionDateTime: "",
    LastModified: now,
    // complete sets ProjectStatus 3 (completed); 0 = default/active
    ...(rowValue(row, "ProjectStatus") === "3" ? { ProjectStatus: "0" } : {}),
  };
}

/** MLO spaces siblings out so an insertion between two of them always has room. */
export const ITEM_INDEX_STEP = 100;

/**
 * The ItemIndex a task takes among `siblings` (their current indices, in
 * outline order). `position` is a 0-based slot; out of range or absent means
 * "last". Inserting between two neighbours takes the midpoint, which is why
 * MLO leaves gaps in the first place.
 */
export function itemIndexAt(siblings: readonly number[], position?: number): number {
  const ordered = [...siblings].sort((a, b) => a - b);
  const last = ordered.length ? ordered[ordered.length - 1]! : 0;
  if (position === undefined || position >= ordered.length) return last + ITEM_INDEX_STEP;
  const after = ordered[Math.max(0, position)]!;
  // Ahead of the first sibling there is no lower neighbour to halve towards, so
  // take a full step below it — the one direction with unlimited room.
  if (position <= 0) return after > 0 ? Math.floor(after / 2) : after - ITEM_INDEX_STEP;
  const before = ordered[position - 1]!;
  const midpoint = Math.floor((before + after) / 2);
  // No room between neighbours (adjacent integers): land on the slot itself
  // and let MLO's own ordering settle the tie rather than reindex siblings.
  return midpoint > before ? midpoint : after;
}

export interface CapturedLine {
  caption: string;
  note?: string;
  /** Context captions named inline with a trailing `@name` token. */
  places: string[];
}

/**
 * The rapid-entry subset this server parses: the first line is the caption,
 * anything after a blank line is the note, and trailing `@context` tokens on
 * the caption line name contexts. MLO's own rapid entry understands more
 * (dates, importance); those stay unparsed rather than guessed at, and land in
 * the caption verbatim.
 */
export function parseCaptureLine(line: string): CapturedLine {
  const [head = "", ...rest] = line.split(/\r?\n\r?\n/);
  const note = rest.join("\n\n").trim();
  const words = head.trim().split(/\s+/).filter(Boolean);
  const places: string[] = [];
  while (words.length > 1 && /^@\S+$/.test(words[words.length - 1]!)) {
    places.unshift(words.pop()!.slice(1));
  }
  return { caption: words.join(" "), places, ...(note ? { note } : {}) };
}

import type { TaskNode } from "../types.js";
import { renumbered } from "../task-tree.js";
import { normalizeGuid, TODO_ITEMS_HEADER } from "../cloud/delta.js";
import type { DeltaRow, WriteId } from "./mlo-repository.js";

/**
 * Read-your-own-writes (spec section 2): the durably accepted writes MLO has
 * not applied yet, composed onto a fresh export at read time.
 *
 * Derived, never stored. The queue is the whole state — an overlay entry
 * disappears the moment its write leaves the queue, whether it left delivered
 * (the export now carries it), expired, or superseded. That is why an expiry
 * drops **silently** here: a read that announced a failure would be lying
 * about the outline, and loudness belongs in `write_status` / `cloud_status`.
 *
 * Rows, not verbs: an authored write is already a complete 82-column row per
 * task plus a tombstone section, so the verb is readable off the rows
 * themselves. A row whose UID the export knows is an update (a completion is
 * one of those, with `CompletionDateTime` filled); a row whose UID it does not
 * is an add; a tombstone hides the task and its subtree.
 */

/** What the overlay needs of one durably accepted write. */
export interface PendingRows {
  writeId: WriteId;
  /**
   * When the write gives up. Honoured here because the queue is swept lazily
   * (the resident expires writes when it next looks at the queue), so a read
   * can meet a row that is past its deadline and still on disk. Overlaying it
   * would promise a landing the write already gave up on.
   */
  expiresAt?: string;
  /** The authored delta rows, exactly as the repository accepted them. */
  rows: readonly DeltaRow[];
}

/** The pending queue as a reader — the overlay never enqueues or removes. */
export interface PendingReader {
  pending(): Promise<PendingRows[]>;
}

const COLUMN = new Map(TODO_ITEMS_HEADER.map((name, index) => [name, index]));

/**
 * Column -> TaskNode field for the fields a write can express. Deliberately
 * partial: relation sets (contexts, dependencies) and flags travel as UIDs the
 * export names by caption, and an overlay that showed a raw GUID where the
 * export shows `@Office` would read as a change nobody made.
 */
const STRINGS: ReadonlyArray<readonly [string, "Note" | "DueDateTime" | "StartDateTime" | "CompletionDateTime"]> = [
  ["Note", "Note"],
  ["DueDateTime", "DueDateTime"],
  ["StartDateTime", "StartDateTime"],
  ["CompletionDateTime", "CompletionDateTime"],
];
const NUMBERS: ReadonlyArray<readonly [string, "Importance" | "Effort" | "EstimateMin" | "EstimateMax" | "ProjectStatus" | "TheGoal"]> = [
  ["Importance", "Importance"],
  ["Effort", "Effort"],
  ["EstimateMin", "EstimateMin"],
  ["EstimateMax", "EstimateMax"],
  ["ProjectStatus", "ProjectStatus"],
  ["GoalFor", "TheGoal"],
];
const BOOLEANS: ReadonlyArray<
  readonly [string, "IsProject" | "Starred" | "HideInToDo" | "HideInToDoThisTask" | "CompleteSubTasksInOrder"]
> = [
  ["IsProject", "IsProject"],
  ["Starred", "Starred"],
  ["HideInToDo", "HideInToDo"],
  ["HideInToDoThisTask", "HideInToDoThisTask"],
  ["CompleteInOrder", "CompleteSubTasksInOrder"],
];

function cell(values: readonly string[], column: string): string {
  const index = COLUMN.get(column);
  return index === undefined ? "" : (values[index] ?? "");
}

/** CSV truth: MLO writes "1"/"0" in deltas; anything else non-empty counts as set. */
function truthy(value: string): boolean {
  return value !== "" && value !== "0";
}

function uidOf(value: string): string | undefined {
  try {
    return value ? normalizeGuid(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every mapped field the row carries, with "" meaning cleared — the row is
 * complete, so an empty cell is a real absence rather than a field the write
 * left alone. `Caption` is the one exception: TaskNode requires one, and a
 * cleared caption would leave the tree with a nameless task, so an empty one
 * is left to whatever the export said.
 */
function fieldsFrom(values: readonly string[]): Partial<TaskNode> {
  const fields: Record<string, unknown> = {};
  const caption = cell(values, "Caption");
  if (caption !== "") fields.Caption = caption;
  for (const [column, field] of STRINGS) {
    const raw = cell(values, column);
    fields[field] = raw === "" ? undefined : raw;
  }
  for (const [column, field] of NUMBERS) {
    const raw = cell(values, column);
    const parsed = Number(raw);
    fields[field] = raw === "" || Number.isNaN(parsed) ? undefined : parsed;
  }
  for (const [column, field] of BOOLEANS) {
    // Only ever `true` or absent, matching the export: a false flag is a field
    // the read tools omit, not one they report as off.
    fields[field] = truthy(cell(values, column)) ? true : undefined;
  }
  return fields as Partial<TaskNode>;
}

function clone(tasks: readonly TaskNode[]): TaskNode[] {
  return tasks.map((task) => ({ ...task, Places: [...task.Places], DependsOn: [...task.DependsOn], Children: clone(task.Children) }));
}

/**
 * Two indexes over the working tree: uid -> task, and task -> the child list
 * holding it. The second is what lets a re-parenting write move a node without
 * re-walking the tree per row.
 */
interface Placed {
  byUid: Map<string, TaskNode>;
  siblingsOf: Map<TaskNode, TaskNode[]>;
}

function index(tasks: TaskNode[], placed: Placed): Placed {
  for (const task of tasks) {
    const uid = uidOf(task.Guid ?? "");
    if (uid) placed.byUid.set(uid, task);
    placed.siblingsOf.set(task, tasks);
    index(task.Children, placed);
  }
  return placed;
}

/** Detach a node from wherever it sits and append it under its new home. */
function reparent(task: TaskNode, destination: TaskNode[], placed: Placed): void {
  const siblings = placed.siblingsOf.get(task);
  if (siblings === destination) return;
  if (siblings) {
    const at = siblings.indexOf(task);
    if (at >= 0) siblings.splice(at, 1);
  }
  destination.push(task);
  placed.siblingsOf.set(task, destination);
}

function removeAll(tasks: TaskNode[], doomed: ReadonlySet<TaskNode>): TaskNode[] {
  return tasks
    .filter((task) => !doomed.has(task))
    .map((task) => {
      task.Children = removeAll(task.Children, doomed);
      return task;
    });
}

/**
 * Compose the pending writes onto a task tree. `pending` is oldest-first, so a
 * later write's view of a task wins — the same order MLO's own Apply would
 * take. Returns the input untouched when nothing is pending.
 */
export function overlayPendingWrites(
  tasks: TaskNode[],
  pending: readonly PendingRows[],
  now = Date.now(),
): TaskNode[] {
  const live = pending.filter((write) => {
    if (!write.expiresAt) return true;
    const expiresAt = Date.parse(write.expiresAt);
    return Number.isNaN(expiresAt) || expiresAt > now;
  });
  if (!live.length) return tasks;
  let overlaid = clone(tasks);
  const placed = index(overlaid, { byUid: new Map(), siblingsOf: new Map() });
  const { byUid } = placed;
  const doomed = new Set<TaskNode>();

  for (const write of live) {
    for (const row of write.rows) {
      if (row.section !== "TodoItems") continue;
      const uid = uidOf(cell(row.values, "UID"));
      if (!uid) continue;
      // An unknown parent (no row for it in this queue, and none in the export)
      // reads as the top level rather than dropping the task: a task the caller
      // cannot see at all is worse than one shown a level too high.
      const parentUid = uidOf(cell(row.values, "ParentUID"));
      const parent = parentUid ? byUid.get(parentUid) : undefined;
      const destination = parent ? parent.Children : overlaid;
      const existing = byUid.get(uid);
      if (existing) {
        Object.assign(existing, fieldsFrom(row.values), { pending: true, writeId: write.writeId });
        // Every authored row carries ParentUID, so a move is just an update
        // whose parent moved. Slot order is not recoverable from ItemIndex
        // against an export tree, so a moved task lands last among its new
        // siblings — the parent is what the caller asked to change.
        reparent(existing, destination, placed);
        continue;
      }
      const phantom: TaskNode = {
        id: "",
        Guid: uid,
        Caption: "",
        Places: [],
        DependsOn: [],
        Children: [],
        Path: [],
        Depth: 0,
        ...fieldsFrom(row.values),
        pending: true,
        writeId: write.writeId,
      };
      byUid.set(uid, phantom);
      destination.push(phantom);
      placed.siblingsOf.set(phantom, destination);
    }
    for (const row of write.rows) {
      if (row.section !== "TodoItems.Deleted") continue;
      const uid = uidOf(row.values[0] ?? "");
      const target = uid ? byUid.get(uid) : undefined;
      // The whole subtree goes with it: `delete` tombstones every descendant,
      // and a hidden parent with visible children is not a state MLO can reach.
      if (target) doomed.add(target);
    }
  }

  if (doomed.size) overlaid = removeAll(overlaid, doomed);
  return renumbered(overlaid);
}

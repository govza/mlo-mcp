import type { TaskNode } from "../types.js";
import { containerKind, isCompleted } from "../task-tree.js";
import type { Snapshot } from "../repo/mlo-repository.js";
import { expandContext, isOpenAt, normalizeContext, readPlaces, type PlaceDefinition } from "../places.js";

/**
 * Why a task is not an action right now. Two families, deliberately in one
 * union because a caller only ever asks "can I do this?":
 *
 * - *not visible at all* (`completed` / `branch` / `folder` / `hidden` /
 *   `out-of-order`) — the To-Do list never lists the task;
 * - *deferred* (`blocked-by-dependency` / `starts-later` / `context-closed`) —
 *   the task is an action, just not yet.
 */
export interface Block {
  kind:
    | "completed"
    | "branch"
    | "folder"
    | "hidden"
    | "out-of-order"
    | "blocked-by-dependency"
    | "starts-later"
    | "context-closed";
  detail: string;
}

const INVISIBLE: ReadonlySet<Block["kind"]> = new Set(["completed", "branch", "folder", "hidden", "out-of-order"]);

export interface TaskAvailability {
  task: TaskNode;
  /** The To-Do list would list this task at all (the leaf rule and the flags). */
  visible: boolean;
  /** Visible, and nothing defers it at the engine's `now`. */
  available: boolean;
  /** Every reason it is not available; empty when it is. */
  blocks: Block[];
  /** Relative importance multiplied down the branch; 100 = normal. */
  importance: number;
  /** Approximated computed-score priority — see `score()`. */
  score: number;
}

/**
 * The availability + leaf-visibility computation both read services consume
 * ([spec section 3](../../../docs/adr/0005-target-architecture-spec.md)):
 * the leaf rule, the Folder/Hide flags, complete-subtasks-in-order, dependency
 * blocking, start dates and context open hours, plus the ranking that orders
 * what survives. An internal seam with its own tests — deliberately not on
 * `ToolContext`, so `NextActionsService` and `ReviewService` share it without
 * calling each other.
 *
 * Built per snapshot: everything is evaluated in one pass at construction, so
 * `now` is fixed for the whole answer rather than drifting between tasks.
 */
export class AvailabilityEngine {
  private readonly places: PlaceDefinition[];
  private readonly placeByCaption: Map<string, PlaceDefinition>;
  private readonly entries: TaskAvailability[];
  private readonly byId: Map<string, TaskAvailability>;
  /** Context expansion is per caption, not per task: memoized so a filter walks the includes graph once. */
  private readonly expansions = new Map<string, Set<string>>();

  constructor(snapshot: Pick<Snapshot, "tasks" | "doc">, opts: { now?: Date } = {}) {
    const now = opts.now ?? new Date();
    this.places = readPlaces(snapshot.doc);
    this.placeByCaption = new Map(this.places.map((p) => [normalizeContext(p.Caption), p]));
    this.entries = this.evaluate(snapshot.tasks, now);
    this.byId = new Map(this.entries.map((e) => [e.task.id, e]));
  }

  /** Every task in the outline, evaluated. Outline order. */
  all(): TaskAvailability[] {
    return this.entries;
  }

  /** What the To-Do list would list, highest-ranked first. Includes deferred actions — filter on `available`. */
  actions(): TaskAvailability[] {
    return this.entries.filter((e) => e.visible).sort(byRank);
  }

  of(id: string): TaskAvailability | undefined {
    return this.byId.get(id);
  }

  /**
   * Does a filter for `caption` reach this task? Contexts are hierarchical, so
   * a filter for Home matches a task tagged only Phone when Home includes it.
   */
  inContext(entry: TaskAvailability, caption: string): boolean {
    let reached = this.expansions.get(caption);
    if (!reached) {
      reached = expandContext(this.places, caption);
      this.expansions.set(caption, reached);
    }
    return entry.task.Places.some((p) => reached.has(normalizeContext(p)));
  }

  private evaluate(tasks: TaskNode[], now: Date): TaskAvailability[] {
    const completedUids = new Set<string>();
    const knownUids = new Set<string>();
    const walkUids = (list: TaskNode[]) => {
      for (const t of list) {
        if (t.Guid) {
          const uid = normalizeUid(t.Guid);
          knownUids.add(uid);
          if (isCompleted(t)) completedUids.add(uid);
        }
        walkUids(t.Children);
      }
    };
    walkUids(tasks);

    const out: TaskAvailability[] = [];
    const walk = (list: TaskNode[], inherited: Inherited) => {
      let sequentialTaken = false;
      for (const t of list) {
        const importance = inherited.importance * ((t.Importance ?? 100) / 100);
        // A sequential parent shows only its first open child; every later
        // sibling waits, and so does everything nested under that sibling —
        // otherwise a step's own subtasks would leak into the To-Do list past
        // the step MLO is holding back.
        const outOfOrder = inherited.outOfOrderAbove || (inherited.sequentialParent && sequentialTaken);
        if (inherited.sequentialParent && !isCompleted(t)) sequentialTaken = true;

        const blocks = this.blocksFor(t, {
          now,
          completedAbove: inherited.completedAbove,
          hiddenAbove: inherited.hiddenAbove,
          outOfOrder,
          completedUids,
          knownUids,
        });
        out.push({
          task: t,
          visible: !blocks.some((b) => INVISIBLE.has(b.kind)),
          available: blocks.length === 0,
          blocks,
          importance,
          score: score(importance, t, now),
        });
        walk(t.Children, {
          importance,
          completedAbove: inherited.completedAbove || isCompleted(t),
          hiddenAbove: inherited.hiddenAbove || Boolean(t.HideInToDo),
          outOfOrderAbove: outOfOrder,
          sequentialParent: Boolean(t.CompleteSubTasksInOrder),
        });
      }
    };
    walk(tasks, { importance: 100, completedAbove: false, hiddenAbove: false, outOfOrderAbove: false, sequentialParent: false });
    return out;
  }

  private blocksFor(
    t: TaskNode,
    ctx: {
      now: Date;
      completedAbove: boolean;
      hiddenAbove: boolean;
      outOfOrder: boolean;
      completedUids: Set<string>;
      knownUids: Set<string>;
    }
  ): Block[] {
    const blocks: Block[] = [];
    if (ctx.completedAbove) blocks.push({ kind: "completed", detail: "completed ancestor" });
    else if (isCompleted(t)) blocks.push({ kind: "completed", detail: t.CompletionDateTime ? `completed ${t.CompletionDateTime}` : "project status completed" });
    if (t.Children.some((c) => !isCompleted(c))) {
      blocks.push({ kind: "branch", detail: "has uncompleted subtasks — its leaves are the actions" });
    }
    if (containerKind(t) === "folder") {
      blocks.push({ kind: "folder", detail: "marked Folder: a container, never an action" });
    }
    if (t.HideInToDo || ctx.hiddenAbove) {
      blocks.push({ kind: "hidden", detail: "hidden from To-Do views by a hide-in-todo branch" });
    }
    if (ctx.outOfOrder) {
      blocks.push({ kind: "out-of-order", detail: "its parent completes subtasks in order and an earlier one is open" });
    }

    // Only unresolved-but-known blockers count: a dependency on a UID this
    // export never carried is unverifiable, and refusing to show the task on
    // that basis would hide work for a reason nobody can inspect.
    //
    // ALL semantics, no delay: MLO's configurable ALL-vs-ANY operator and its
    // delayed-dependency postpone live in the CSV row model
    // ([docs/mlo/cloud-sync.md](../../../docs/mlo/cloud-sync.md)) but not in
    // the XML export this reads, so the strict reading is the only one
    // available here. A task shown as blocked under ANY may in fact be free.
    const waitingOn = t.DependsOn.map(normalizeUid).filter(
      (uid) => ctx.knownUids.has(uid) && !ctx.completedUids.has(uid)
    );
    if (waitingOn.length) {
      blocks.push({ kind: "blocked-by-dependency", detail: `waits for ${waitingOn.length} uncompleted task(s)` });
    }
    if (t.StartDateTime && t.StartDateTime > localIso(ctx.now)) {
      blocks.push({ kind: "starts-later", detail: `starts ${t.StartDateTime}` });
    }
    if (t.Places.length && !t.Places.some((p) => isOpenAt(this.placeByCaption.get(normalizeContext(p)), ctx.now))) {
      blocks.push({ kind: "context-closed", detail: `every context is closed now: ${t.Places.join(", ")}` });
    }
    return blocks;
  }
}

/** What a task inherits from the branch above it during one evaluation pass. */
interface Inherited {
  /** Absolute importance of the parent; relative sliders multiply down the branch. */
  importance: number;
  /** A completed parent makes its entire subtree invisible in To-Do views. */
  completedAbove: boolean;
  hiddenAbove: boolean;
  /** An ancestor is a later step of a sequential branch, so this whole subtree waits with it. */
  outOfOrderAbove: boolean;
  /** The immediate parent completes its subtasks in order. */
  sequentialParent: boolean;
}

/** MLO writes GUIDs braced and in mixed case; the export and the model must compare as one. */
function normalizeUid(uid: string): string {
  return uid.replace(/[{}]/g, "").toLowerCase();
}

/** MLO's date fields are local wall-clock without a zone, so `now` must be too. */
function localIso(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

const MS_PER_DAY = 86_400_000;

/**
 * Both weight factors are the profile's own 0-6 dials
 * ([docs/mlo/mlo-task-model.md](../../../docs/mlo/mlo-task-model.md) §2),
 * stored in the data file's options, which the XML export does not carry.
 * Neutral 1 is the only honest stand-in; the shape of the formula, not the
 * dial, is what orders the list.
 */
const START_WEIGHT = 1;
const DUE_WEIGHT = 1;

/** Days elapsed since a local wall-clock MLO date; negative while it is still ahead. */
function daysSince(dateTime: string, now: Date): number {
  const parsed = Date.parse(dateTime);
  return Number.isNaN(parsed) ? 0 : (now.getTime() - parsed) / MS_PER_DAY;
}

/**
 * An approximation of MLO's computed-score priority
 * ([docs/mlo/mlo-task-model.md](../../../docs/mlo/mlo-task-model.md) §2):
 * absolute importance plus the date contribution, which grows the longer a
 * task has been startable and the closer (then further past) its due date.
 * Following the documented formula, a date still ahead contributes
 * *negatively* — an undated task outranks one that cannot be due for months.
 *
 * One input is deliberately absent rather than guessed: the urgency slider,
 * which the XML export does not carry at all. MLO multiplies importance by
 * urgency; with urgency unknowable here that term is 1, which is why this
 * orders tasks the way MLO would without claiming to reproduce its number.
 * The unit is one point per day.
 */
function score(importance: number, t: TaskNode, now: Date): number {
  const start = t.StartDateTime ? START_WEIGHT * daysSince(t.StartDateTime, now) : 0;
  const due = t.DueDateTime ? DUE_WEIGHT * daysSince(t.DueDateTime, now) : 0;
  return importance + start + due;
}

function byRank(a: TaskAvailability, b: TaskAvailability): number {
  // Doable work outranks deferred work regardless of score: a caller that
  // asked to see blocked actions too still wants the ones it can act on now
  // at the top. Within each group the computed score decides.
  if (a.available !== b.available) return a.available ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  const due = (a.task.DueDateTime ?? "￿").localeCompare(b.task.DueDateTime ?? "￿");
  if (due !== 0) return due;
  return a.task.id.localeCompare(b.task.id);
}

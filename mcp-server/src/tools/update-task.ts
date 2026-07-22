import { z } from "zod";
import { resolveNamed, rowValue, type KnownCloudProjection, type KnownRow } from "../cloud/log-projection.js";
import { buildUidResolver } from "../cloud/structure-align.js";
import { flatten, findById } from "../task-tree.js";
import { csvTruthy, runCloudRowUpdate, type CloudRowTarget } from "./row-update.js";
import { defineTool } from "./shared.js";
import type { TaskNode } from "../types.js";

const CloudUpdateEntry = z.object({
  id: z.string().describe("Path-based task id"),
  Caption: z.string().min(1).optional(),
  Note: z.string().optional().describe('"" clears'),
  Importance: z.number().min(0).max(200).optional().describe("0–200; 100 = normal"),
  Effort: z.number().min(0).max(200).optional(),
  DueDateTime: z.string().optional().describe('ISO like "2026-08-01T15:00:00"; "" clears'),
  StartDateTime: z.string().optional(),
  CompletionDateTime: z.string().optional().describe('"" reopens (or use uncomplete_task)'),
  ProjectStatus: z.number().int().optional(),
  EstimateMin: z.number().optional().describe("fractional days"),
  EstimateMax: z.number().optional(),
  TheGoal: z.number().int().min(0).max(3).optional().describe("0 none, 1 weekly, 2 monthly, 3 yearly"),
  IsProject: z.boolean().optional(),
  Starred: z.boolean().optional(),
  Folder: z.boolean().optional().describe("Hide only this task from To-Do views; its children remain eligible"),
  HideInToDo: z.boolean().optional().describe("Hide this task and its whole branch from To-Do views"),
  CompleteSubTasksInOrder: z.boolean().optional(),
  Flag: z.string().optional().describe('Existing flag caption; "" clears'),
  Places: z.array(z.string().min(1)).max(25).optional()
    .describe("Complete replacement set of existing context captions; [] clears all contexts"),
  dependsOnIds: z.array(z.string()).max(25).optional()
    .describe("Complete replacement set of path ids this task waits for; [] clears all dependencies"),
  moveToParentId: z.string().optional()
    .describe('Re-parent: move this task (with its whole subtree) under the given task id; "" moves it to the top level'),
});
type CloudUpdateSpec = z.infer<typeof CloudUpdateEntry>;

const STRING_COLUMNS = ["Caption", "Note", "DueDateTime", "StartDateTime", "CompletionDateTime"] as const;
const NUMBER_COLUMNS: ReadonlyArray<readonly [keyof CloudUpdateSpec, string]> = [
  ["Importance", "Importance"],
  ["Effort", "Effort"],
  ["ProjectStatus", "ProjectStatus"],
  ["EstimateMin", "EstimateMin"],
  ["EstimateMax", "EstimateMax"],
  ["TheGoal", "GoalFor"],
];
const BOOLEAN_COLUMNS: ReadonlyArray<readonly [keyof CloudUpdateSpec, string]> = [
  ["IsProject", "IsProject"],
  ["Starred", "Starred"],
  ["Folder", "HideInToDoThisTask"],
  ["HideInToDo", "HideInToDo"],
  ["CompleteSubTasksInOrder", "CompleteInOrder"],
];

export interface MoveDestination {
  /** Empty string re-parents to the top level. */
  parentUid: string;
  destCaption?: string;
}

export interface ResolvedUpdateValues { flagUid?: string; dependencyUids?: readonly string[] }

export function updatePatch(
  spec: CloudUpdateSpec,
  known: KnownRow,
  now: string,
  move?: MoveDestination,
  resolved: ResolvedUpdateValues = {},
): Record<string, string> {
  const patch: Record<string, string> = { LastModified: now };
  for (const column of STRING_COLUMNS) {
    const value = spec[column];
    if (value !== undefined) patch[column] = value;
  }
  for (const [field, column] of NUMBER_COLUMNS) {
    const value = spec[field];
    if (value !== undefined) patch[column] = String(value);
  }
  for (const [field, column] of BOOLEAN_COLUMNS) {
    const value = spec[field];
    if (typeof value === "boolean") patch[column] = value ? "1" : "0";
  }
  if (spec.Starred !== undefined && csvTruthy(rowValue(known, "Starred")) !== spec.Starred) {
    patch.StarToggleDateTime = now;
  }
  if (spec.Flag !== undefined) patch.FlagUID = resolved.flagUid ?? "";
  if (move) patch.ParentUID = move.parentUid;
  if (spec.DueDateTime !== undefined || spec.StartDateTime !== undefined) {
    const due = spec.DueDateTime ?? rowValue(known, "DueDateTime");
    const start = spec.StartDateTime ?? rowValue(known, "StartDateTime");
    // Mirror add_task: dates need ScheduleType 1; both cleared → back to 0.
    // Nonzero values other than 1 are left alone — their semantics are unobserved.
    if (due === "" && start === "") patch.ScheduleType = "0";
    else if (!csvTruthy(rowValue(known, "ScheduleType"))) patch.ScheduleType = "1";
  }
  return patch;
}

export function verifiesUpdate(
  task: TaskNode,
  spec: CloudUpdateSpec,
  move?: MoveDestination,
  resolved: ResolvedUpdateValues = {},
): boolean {
  if (spec.Caption !== undefined && task.Caption !== spec.Caption) return false;
  if (spec.Note !== undefined && (task.Note ?? "") !== spec.Note) return false;
  if (spec.DueDateTime !== undefined && (task.DueDateTime ?? "") !== spec.DueDateTime) return false;
  if (spec.StartDateTime !== undefined && (task.StartDateTime ?? "") !== spec.StartDateTime) return false;
  if (spec.CompletionDateTime !== undefined && (task.CompletionDateTime ?? "") !== spec.CompletionDateTime) return false;
  if (spec.IsProject !== undefined && (task.IsProject ?? false) !== spec.IsProject) return false;
  if (spec.Starred !== undefined && (task.Starred ?? false) !== spec.Starred) return false;
  if (spec.Folder !== undefined && (task.HideInToDoThisTask ?? false) !== spec.Folder) return false;
  if (spec.HideInToDo !== undefined && (task.HideInToDo ?? false) !== spec.HideInToDo) return false;
  if (spec.CompleteSubTasksInOrder !== undefined && (task.CompleteSubTasksInOrder ?? false) !== spec.CompleteSubTasksInOrder) return false;
  if (spec.Flag !== undefined && (task.Flag ?? "").toLocaleLowerCase() !== spec.Flag.toLocaleLowerCase()) return false;
  if (spec.Places !== undefined) {
    const expected = [...new Set(spec.Places.map((place) => place.toLocaleLowerCase()))].sort();
    const actual = task.Places.map((place) => place.toLocaleLowerCase()).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  if (spec.dependsOnIds !== undefined) {
    const expected = [...(resolved.dependencyUids ?? [])].map((uid) => uid.toUpperCase()).sort();
    const actual = task.DependsOn.map((uid) => uid.toUpperCase()).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  if (move) return move.destCaption ? task.Path.at(-2) === move.destCaption : task.Path.length === 1;
  return true;
}

function nextStarredIndex(cloud: KnownCloudProjection): number {
  const values = [...cloud.starredOrderByTask.values()].map(Number).filter(Number.isFinite);
  return (values.length ? Math.max(...values) : 0) + 500;
}

export const updateTaskTool = defineTool({
  name: "update_task",
  title: "Update tasks",
  description:
    "Queue full-row field edits (and re-parenting moves) for one or more tasks, trigger QuickSync, and verify in " +
    "a fresh export. Only provided fields change; \"\" clears a text field. The whole batch travels as ONE delta. " +
    "Only works for tasks whose complete record is in the delta log (added by this server or changed in MLO since " +
    "the local endpoint took over); date edits on recurring tasks are refused. IsProject, Starred, Folder, " +
    "visibility, sequential-subtask mode, existing Flag assignment, complete context replacement, and complete " +
    "dependency replacement are supported.",
  inputSchema: {
    updates: z.array(CloudUpdateEntry).min(1).max(25).describe("Per-task updates (max 25), applied in one delta"),
  },
  outputSchema: {
    uids: z.array(z.string()),
    cursor: z.string(),
    verified: z.boolean(),
    message: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  execute({ updates }, ctx) {
    const specs = new Map<string, CloudUpdateSpec>();
    for (const spec of updates) {
      if (specs.has(spec.id)) throw new Error(`duplicate id "${spec.id}" in updates — merge those entries into one`);
      const { id, moveToParentId, ...fields } = spec;
      if (Object.values(fields).every((value) => value === undefined) && moveToParentId === undefined) {
        throw new Error(`entry for id "${id}" has nothing to update — pass at least one field`);
      }
      specs.set(id, spec);
    }
    const moves = new Map<string, MoveDestination>();
    const flagUids = new Map<string, string>();
    const placeUids = new Map<string, string[]>();
    const starredOrder = new Map<string, string>();
    const dependencyUids = new Map<string, string[]>();
    return runCloudRowUpdate(ctx, [...specs.keys()], {
      verb: "Update",
      prepare(before: TaskNode[], targets: CloudRowTarget[], cloud: KnownCloudProjection) {
        const resolveUid = buildUidResolver(before, cloud);
        let starIndex = nextStarredIndex(cloud);
        for (const { id, task } of targets) {
          const spec = specs.get(id)!;
          if (spec.Flag !== undefined && spec.Flag !== "") flagUids.set(id, resolveNamed(spec.Flag, cloud.flags, "flag"));
          if (spec.Places !== undefined) {
            const unique = [...new Set(spec.Places.map((place) => place.toLocaleLowerCase()))];
            if (unique.length !== spec.Places.length) throw new Error(`duplicate context in Places for [${id}] "${task.Caption}"`);
            placeUids.set(id, spec.Places.map((place) => resolveNamed(place, cloud.places, "context")));
          }
          if (spec.dependsOnIds !== undefined) {
            const unique = [...new Set(spec.dependsOnIds)];
            if (unique.length !== spec.dependsOnIds.length) {
              throw new Error(`duplicate id in dependsOnIds for [${id}] "${task.Caption}"`);
            }
            const dependencies = spec.dependsOnIds.map((dependencyId) => {
              const dependency = findById(before, dependencyId);
              if (!dependency) throw new Error(`no dependency task with id "${dependencyId}" — re-run list_tasks`);
              if (dependency === task) throw new Error(`[${id}] "${task.Caption}" cannot depend on itself`);
              const dependencyUid = resolveUid(dependency);
              if (!dependencyUid) {
                throw new Error(`no recoverable GUID for dependency [${dependencyId}] "${dependency.Caption}"`);
              }
              return dependencyUid;
            });
            dependencyUids.set(id, dependencies);
          }
          if (spec.Starred === true) {
            const taskUid = resolveUid(task);
            const current = taskUid ? cloud.starredOrderByTask.get(taskUid) : undefined;
            starredOrder.set(id, current || String(starIndex));
            if (!current) starIndex += 500;
          }
          const moveTo = spec.moveToParentId;
          if (moveTo === undefined) continue;
          if (moveTo === "") {
            moves.set(id, { parentUid: "" });
            continue;
          }
          const dest = findById(before, moveTo);
          if (!dest) throw new Error(`no task with id "${moveTo}" to move under — re-run list_tasks`);
          if (flatten([task]).includes(dest)) {
            throw new Error(`cannot move [${id}] "${task.Caption}" into its own subtree`);
          }
          const destUid = resolveUid(dest);
          if (!destUid) {
            throw new Error(
              `no recoverable GUID for move destination [${moveTo}] "${dest.Caption}" — move the task in the MLO app`
            );
          }
          moves.set(id, { parentUid: destUid, destCaption: dest.Caption });
        }
      },
      guard({ id, task, known }) {
        const spec = specs.get(id)!;
        const editsDates =
          spec.DueDateTime !== undefined || spec.StartDateTime !== undefined || spec.CompletionDateTime !== undefined;
        if (editsDates && csvTruthy(rowValue(known, "RecType"))) {
          throw new Error(
            `[${id}] "${task.Caption}" is recurring — date edits through the cloud path can desync the series; ` +
              "nothing was queued; edit it in MLO instead"
          );
        }
      },
      patchFor: ({ id, known }, now) => updatePatch(
        specs.get(id)!, known, now, moves.get(id), { ...(flagUids.has(id) ? { flagUid: flagUids.get(id)! } : {}) },
      ),
      placeUidsFor: ({ id, placeUids: current }) => placeUids.get(id) ?? current,
      dependencyUidsFor: ({ id, dependencyUids: current }) => dependencyUids.get(id) ?? current,
      starredOrderIndexFor: ({ id }) => starredOrder.get(id),
      verified: (task, { id }) => verifiesUpdate(
        task, specs.get(id)!, moves.get(id), { ...(dependencyUids.has(id) ? { dependencyUids: dependencyUids.get(id)! } : {}) },
      ),
    });
  },
});

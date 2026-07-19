import { z } from "zod";
import { rowValue, type KnownRow } from "../cloud/log-projection.js";
import { flatten, findById } from "../task-tree.js";
import { csvTruthy, runCloudRowUpdate, type CloudRowTarget } from "./row-update.js";
import { defineTool } from "./shared.js";
import type { TaskNode } from "../types.js";

/**
 * Only fields with an OBSERVED TodoItems projection are supported. Excluded
 * until their wire encoding is captured from a real app delta: booleans
 * (IsProject/Starred/HideInToDo/… — the CSV true-value, "1" vs Delphi "-1",
 * has never been observed), Flag (needs FlagUID resolution), Places and
 * dependsOn (relation removal semantics unobserved; no TodoItemPlaces.Deleted
 * section exists in the skeleton).
 */
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

export interface MoveDestination {
  /** Empty string re-parents to the top level. */
  parentUid: string;
  destCaption?: string;
}

export function updatePatch(spec: CloudUpdateSpec, known: KnownRow, now: string, move?: MoveDestination): Record<string, string> {
  const patch: Record<string, string> = { LastModified: now };
  for (const column of STRING_COLUMNS) {
    const value = spec[column];
    if (value !== undefined) patch[column] = value;
  }
  for (const [field, column] of NUMBER_COLUMNS) {
    const value = spec[field];
    if (value !== undefined) patch[column] = String(value);
  }
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

export function verifiesUpdate(task: TaskNode, spec: CloudUpdateSpec, move?: MoveDestination): boolean {
  if (spec.Caption !== undefined && task.Caption !== spec.Caption) return false;
  if (spec.Note !== undefined && (task.Note ?? "") !== spec.Note) return false;
  if (spec.DueDateTime !== undefined && (task.DueDateTime ?? "") !== spec.DueDateTime) return false;
  if (spec.StartDateTime !== undefined && (task.StartDateTime ?? "") !== spec.StartDateTime) return false;
  if (spec.CompletionDateTime !== undefined && (task.CompletionDateTime ?? "") !== spec.CompletionDateTime) return false;
  if (move) return move.destCaption ? task.Path.at(-2) === move.destCaption : task.Path.length === 1;
  return true;
}

export const updateTaskTool = defineTool({
  name: "update_task",
  title: "Update tasks",
  description:
    "Queue full-row field edits (and re-parenting moves) for one or more tasks, trigger QuickSync, and verify in " +
    "a fresh export. Only provided fields change; \"\" clears a text field. The whole batch travels as ONE delta. " +
    "Only works for tasks whose complete record is in the delta log (added by this server or changed in MLO since " +
    "the local endpoint took over); date edits on recurring tasks are refused. Booleans (IsProject, Starred, " +
    "Hide*), Flag, Places, and dependsOn cannot be edited yet (wire encoding unobserved) — make those changes in " +
    "the MLO app.",
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
    return runCloudRowUpdate(ctx, [...specs.keys()], {
      verb: "Update",
      prepare(before: TaskNode[], targets: CloudRowTarget[]) {
        for (const { id, task } of targets) {
          const moveTo = specs.get(id)!.moveToParentId;
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
          if (!dest.Guid) {
            throw new Error(
              `no recoverable GUID for move destination [${moveTo}] "${dest.Caption}" — move the task in the MLO app`
            );
          }
          moves.set(id, { parentUid: dest.Guid.toUpperCase(), destCaption: dest.Caption });
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
      patchFor: ({ id, known }, now) => updatePatch(specs.get(id)!, known, now, moves.get(id)),
      verified: (task, { id }) => verifiesUpdate(task, specs.get(id)!, moves.get(id)),
    });
  },
});

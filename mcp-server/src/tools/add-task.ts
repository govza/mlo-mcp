import { z } from "zod";
import { buildTaskAddDelta, generateGuid } from "../cloud/delta.js";
import { packEnvelope } from "../cloud/envelope.js";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { quickSync } from "../mlo-cli.js";
import { flatten } from "../task-tree.js";
import { defineTool, nowIso, textResult } from "./shared.js";
import { knownCloudProjection, type NamedCloudObject } from "../cloud/log-projection.js";
import type { TaskNode } from "../types.js";

function matchesInput(task: TaskNode, caption: string, note: string | undefined): boolean {
  return task.Caption === caption && (note === undefined || task.Note === note);
}

function resolveNamed(caption: string, objects: readonly NamedCloudObject[], kind: string): string {
  const matches = objects.filter((object) => object.caption.toLocaleLowerCase() === caption.toLocaleLowerCase());
  if (matches.length === 0) throw new Error(`unknown ${kind} "${caption}" — use an existing ${kind}`);
  if (matches.length > 1) throw new Error(`ambiguous ${kind} "${caption}" — ${matches.length} definitions have that caption`);
  return matches[0]!.uid;
}

function matchesRequestedFields(task: TaskNode, args: {
  IsProject?: boolean; Starred?: boolean; Folder?: boolean; HideInToDo?: boolean;
  CompleteSubTasksInOrder?: boolean; Flag?: string; Places?: string[];
  dependsOnUids?: string[];
}): boolean {
  if (args.IsProject !== undefined && (task.IsProject ?? false) !== args.IsProject) return false;
  if (args.Starred !== undefined && (task.Starred ?? false) !== args.Starred) return false;
  if (args.Folder !== undefined && (task.HideInToDoThisTask ?? false) !== args.Folder) return false;
  if (args.HideInToDo !== undefined && (task.HideInToDo ?? false) !== args.HideInToDo) return false;
  if (args.CompleteSubTasksInOrder !== undefined && (task.CompleteSubTasksInOrder ?? false) !== args.CompleteSubTasksInOrder) return false;
  if (args.Flag !== undefined && (task.Flag ?? "").toLocaleLowerCase() !== args.Flag.toLocaleLowerCase()) return false;
  if (args.Places !== undefined) {
    const expected = args.Places.map((place) => place.toLocaleLowerCase()).sort();
    const actual = task.Places.map((place) => place.toLocaleLowerCase()).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  if (args.dependsOnUids !== undefined) {
    const expected = args.dependsOnUids.map((uid) => uid.toUpperCase()).sort();
    const actual = task.DependsOn.map((uid) => uid.toUpperCase()).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  return true;
}

/**
 * Verify an add by comparing exports from before and after QuickSync.
 *
 * MLO's binary GUID annotator is not reliable enough to be the sole check for
 * a newly merged row, and captions are not unique. A count increase for the
 * exact user-visible values proves that this session added another task even
 * when an older task has the same caption.
 */
export function wasTaskAdded(
  before: TaskNode[],
  after: TaskNode[],
  caption: string,
  note: string | undefined,
  queuedUid: string,
): boolean {
  const beforeMatches = flatten(before).filter((task) => matchesInput(task, caption, note));
  const afterMatches = flatten(after).filter((task) => matchesInput(task, caption, note));
  return afterMatches.some((task) => task.Guid?.toUpperCase() === queuedUid)
    || afterMatches.length > beforeMatches.length;
}

export const addTaskTool = defineTool({
  name: "add_task",
  title: "Add a task",
  description: "Queue a full task delta, trigger QuickSync, and verify whether MLO applied it.",
  inputSchema: {
    caption: z.string().min(1),
    note: z.string().optional(),
    dueDateTime: z.string().optional(),
    startDateTime: z.string().optional(),
    parentUid: z.string().optional(),
    IsProject: z.boolean().optional(),
    Starred: z.boolean().optional(),
    Folder: z.boolean().optional().describe("Hide only this task from To-Do views; children remain eligible"),
    HideInToDo: z.boolean().optional().describe("Hide this task and its whole branch from To-Do views"),
    CompleteSubTasksInOrder: z.boolean().optional(),
    Flag: z.string().optional().describe("Existing flag caption"),
    Places: z.array(z.string().min(1)).max(25).optional().describe("Existing context captions"),
    dependsOnUids: z.array(z.string()).max(25).optional()
      .describe("Stable GUIDs of existing tasks this new task waits for (from get_task)"),
  },
  outputSchema: {
    uid: z.string(),
    cursor: z.string(),
    verified: z.boolean(),
    message: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async execute(args, ctx) {
    const uid = generateGuid();
    const timestamp = nowIso();
    const uniquePlaces = [...new Set((args.Places ?? []).map((place) => place.toLocaleLowerCase()))];
    if (uniquePlaces.length !== (args.Places ?? []).length) throw new Error("duplicate context in Places");
    const dependencyUids = [...new Set((args.dependsOnUids ?? []).map((uid) => uid.toUpperCase()))];
    if (dependencyUids.length !== (args.dependsOnUids ?? []).length) throw new Error("duplicate GUID in dependsOnUids");
    const needsLookups = args.Flag !== undefined || args.Places !== undefined || args.Starred === true;
    const cloud = needsLookups ? await knownCloudProjection(ctx.cloudState) : undefined;
    const flagUid = args.Flag !== undefined ? resolveNamed(args.Flag, cloud!.flags, "flag") : undefined;
    const placeUids = args.Places?.map((place) => resolveNamed(place, cloud!.places, "context"));
    const starredOrderIndex = args.Starred === true
      ? String(Math.max(0, ...[...cloud!.starredOrderByTask.values()].map(Number).filter(Number.isFinite)) + 500)
      : undefined;
    let beforeTasks: TaskNode[] | undefined;
    try {
      beforeTasks = (await ctx.store.getSnapshot(true)).tasks;
    } catch {
      // Queueing must remain available even if the pre-sync export fails. In
      // that case verification falls back to the generated UID only.
    }
    const delta = buildTaskAddDelta({
      uid,
      caption: args.caption,
      createdDate: timestamp,
      lastModified: timestamp,
      ...(args.parentUid ? { parentUid: args.parentUid } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.dueDateTime !== undefined ? { dueDateTime: args.dueDateTime } : {}),
      ...(args.startDateTime !== undefined ? { startDateTime: args.startDateTime } : {}),
      ...(args.IsProject !== undefined ? { isProject: args.IsProject } : {}),
      ...(args.Starred !== undefined ? { starred: args.Starred } : {}),
      ...(args.Folder !== undefined ? { hideInToDoThisTask: args.Folder } : {}),
      ...(args.HideInToDo !== undefined ? { hideInToDo: args.HideInToDo } : {}),
      ...(args.CompleteSubTasksInOrder !== undefined ? { completeInOrder: args.CompleteSubTasksInOrder } : {}),
      ...(flagUid !== undefined ? { flagUid } : {}),
      ...(placeUids !== undefined ? { placeUids } : {}),
      ...(args.dependsOnUids !== undefined ? { dependencyUids } : {}),
      ...(starredOrderIndex !== undefined ? { starredOrderIndex } : {}),
    });
    const cursor = cursorToDecimalString(await ctx.cloudState.append("mcp", packEnvelope(delta)));
    let verified = false;
    let message: string;
    try {
      await quickSync(ctx.config);
      ctx.store.invalidate();
      try {
        const snapshot = await ctx.store.getSnapshot(true);
        const candidates = flatten(snapshot.tasks).filter((task) =>
          (task.Guid?.toUpperCase() === uid || matchesInput(task, args.caption, args.note)) && matchesRequestedFields(task, args)
        );
        verified = beforeTasks
          ? wasTaskAdded(beforeTasks, candidates, args.caption, args.note, uid)
          : candidates.length > 0;
        message = verified
          ? "Task was queued and verified in a fresh MLO export."
          : "Task was queued, but no newly added matching task was present in the fresh export after QuickSync.";
      } catch (error) {
        message = `Task was queued, but verification failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } catch (error) {
      ctx.store.invalidate();
      message = `Task was queued for the next session, but QuickSync failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return textResult(message, { uid, cursor, verified, message });
  },
});

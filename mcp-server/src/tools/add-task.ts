import { z } from "zod";
import { buildTaskAddDelta, generateGuid } from "../cloud/delta.js";
import { packEnvelope } from "../cloud/envelope.js";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { quickSync } from "../mlo-cli.js";
import { flatten } from "../task-tree.js";
import { defineTool, nowIso, textResult } from "./shared.js";
import type { TaskNode } from "../types.js";

function matchesInput(task: TaskNode, caption: string, note: string | undefined): boolean {
  return task.Caption === caption && (note === undefined || task.Note === note);
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
    });
    const cursor = cursorToDecimalString(await ctx.cloudState.append("mcp", packEnvelope(delta)));
    let verified = false;
    let message: string;
    try {
      await quickSync(ctx.config);
      ctx.store.invalidate();
      try {
        const snapshot = await ctx.store.getSnapshot(true);
        verified = beforeTasks
          ? wasTaskAdded(beforeTasks, snapshot.tasks, args.caption, args.note, uid)
          : flatten(snapshot.tasks).some((task) => task.Guid?.toUpperCase() === uid);
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

import { z } from "zod";
import { buildTaskAddDelta, generateGuid } from "../cloud/delta.js";
import { packEnvelope } from "../cloud/envelope.js";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { quickSync } from "../mlo-cli.js";
import { flatten } from "../task-tree.js";
import { defineTool, nowIso, textResult } from "./shared.js";

export const cloudAddTaskTool = defineTool({
  name: "cloud_add_task",
  title: "Add task through local cloud sync",
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
        verified = flatten(snapshot.tasks).some((task) => task.Caption === args.caption);
        message = verified
          ? "Task was queued and verified in a fresh MLO export."
          : "Task was queued, but it was not present in the fresh export; the app may not yet be wired to this endpoint.";
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

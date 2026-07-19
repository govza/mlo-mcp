import { z } from "zod";
import { addTasksTool } from "./add-tasks.js";
import { defineTool, textResult } from "./shared.js";

/**
 * Thin wrapper over add_tasks: one task is a single-entry batch. The caption
 * doubles as the batch key so validation errors read naturally.
 */
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
    const result = await addTasksTool.execute({ tasks: [{ key: args.caption, ...args }] }, ctx);
    const structured = result.structuredContent as
      | { tasks: Array<{ uid: string }>; cursor: string; verified: boolean; message: string }
      | undefined;
    if (result.isError || !structured) return result;
    const { cursor, verified, message } = structured;
    return textResult(message, { uid: structured.tasks[0]!.uid, cursor, verified, message });
  },
});

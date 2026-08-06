import { z } from "zod";
import { WRITE_ACCEPT_OUTPUT, acceptResult } from "./accepted.js";
import { defineTool, NOTE_DESCRIPTION, PATH_ID_CAVEAT } from "./contract.js";

/**
 * The fields one new task can carry, shared with add_tasks. Names follow the
 * service's TaskSpec: TodoItems column names keep the column's capitalization,
 * everything the caller phrases itself stays lowerCamel.
 */
export const TASK_FIELDS = {
  caption: z.string().min(1),
  note: z.string().optional().describe(NOTE_DESCRIPTION),
  dueDateTime: z.string().optional().describe('Local ISO like "2026-08-01T15:00:00"'),
  startDateTime: z.string().optional(),
  IsProject: z.boolean().optional(),
  Starred: z.boolean().optional(),
  Folder: z.boolean().optional().describe("Hide only this task from To-Do views; children remain eligible"),
  HideInToDo: z.boolean().optional().describe("Hide this task and its whole branch from To-Do views"),
  CompleteSubTasksInOrder: z.boolean().optional(),
  Flag: z.string().optional().describe("Existing flag caption"),
  Places: z.array(z.string().min(1)).max(25).optional().describe("Existing context captions, e.g. @Office"),
};

const PARENT_ID = z
  .string()
  .optional()
  .describe(`Path-based id of an existing parent from list_tasks/search_tasks (${PATH_ID_CAVEAT}); omit for top level`);

const DEPENDS_ON_IDS = z
  .array(z.string())
  .max(25)
  .optional()
  .describe(`Path ids of existing tasks this one waits for (${PATH_ID_CAVEAT})`);

export const addTaskTool = defineTool({
  name: "add_task",
  title: "Add a task",
  description:
    "Create one task. Returns at durable accept: MLO applies it on its own next sync, and reads show it " +
    "immediately, flagged pending. Use write_status to see where the write got to.",
  inputSchema: { ...TASK_FIELDS, parentId: PARENT_ID, dependsOnIds: DEPENDS_ON_IDS },
  outputSchema: WRITE_ACCEPT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async execute(args, ctx) {
    return acceptResult(await ctx.outline.add(args), "the new task");
  },
});

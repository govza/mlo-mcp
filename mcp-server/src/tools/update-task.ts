import { z } from "zod";
import { WRITE_ACCEPT_OUTPUT, acceptResult } from "./accepted.js";
import { defineTool, NOTE_DESCRIPTION, PATH_ID_CAVEAT } from "./contract.js";

export const updateTaskTool = defineTool({
  name: "update_task",
  title: "Update a task",
  description:
    "Change fields of one existing task. Only the fields you pass change; \"\" clears a text field, and Places / " +
    "dependsOnIds are COMPLETE replacement sets ([] clears them). Covers the Organize flags too — IsProject, " +
    "Folder, sequential subtasks, dependencies. Date edits on recurring tasks are refused: a full-row rewrite " +
    "would end the series instead of rolling it forward. Returns at durable accept.",
  inputSchema: {
    id: z.string().describe(`Path-based id from list_tasks/search_tasks, e.g. "1.2.3"; ${PATH_ID_CAVEAT}`),
    Caption: z.string().min(1).optional(),
    Note: z.string().optional().describe(`${NOTE_DESCRIPTION}; "" clears`),
    Importance: z.number().min(0).max(200).optional().describe("0–200; 100 = normal"),
    Effort: z.number().min(0).max(200).optional(),
    DueDateTime: z.string().optional().describe('Local ISO like "2026-08-01T15:00:00"; "" clears'),
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
    CompleteSubTasksInOrder: z.boolean().optional().describe("Sequential subtasks: only the first uncompleted child is available"),
    Flag: z.string().optional().describe('Existing flag caption; "" clears'),
    Places: z
      .array(z.string().min(1))
      .max(25)
      .optional()
      .describe("Complete replacement set of existing context captions; [] clears all contexts"),
    dependsOnIds: z
      .array(z.string())
      .max(25)
      .optional()
      .describe(
        `Complete replacement set of Path ids this task waits for (${PATH_ID_CAVEAT}); [] clears all dependencies`,
      ),
  },
  outputSchema: WRITE_ACCEPT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async execute({ id, ...patch }, ctx) {
    return acceptResult(await ctx.outline.update(id, patch), `the edit to [${id}]`);
  },
});

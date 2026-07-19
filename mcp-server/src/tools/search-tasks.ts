import { z } from "zod";
import { searchTasks, renderLine } from "../task-tree.js";
import { defineTool, textResult, toSummary, TaskSummarySchema, DEFAULT_RESULT_LIMIT } from "./shared.js";

export const searchTasksTool = defineTool({
  name: "search_tasks",
  title: "Search tasks",
  description: "Search tasks by text, context, due-date range, star, completion, project flag or MLO flag.",
  inputSchema: {
    query: z.string().optional().describe("Case-insensitive substring matched against caption and note"),
    context: z.string().optional().describe('Context name, e.g. "@Office" or "Office"'),
    dueBefore: z.string().optional().describe("ISO date(-time): tasks due strictly before this"),
    dueAfter: z.string().optional().describe("ISO date(-time): tasks due strictly after this"),
    starred: z.boolean().optional(),
    completed: z.boolean().optional().describe("Default: both; true = only completed; false = only open"),
    isProject: z.boolean().optional(),
    flag: z.string().optional().describe('Exact flag name, e.g. "Green Flag"'),
    minImportance: z.number().min(0).max(200).optional()
      .describe("0–200; 100 = normal, which is what tasks without an explicit Importance count as"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Max tasks to return (default ${DEFAULT_RESULT_LIMIT}); the output notes when truncated`),
  },
  outputSchema: {
    tasks: z.array(TaskSummarySchema),
    total: z.number().describe("Matching tasks before the limit was applied"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute({ limit, ...filters }, ctx) {
    const snap = await ctx.store.getSnapshot();
    const matches = searchTasks(snap.tasks, filters);
    const shown = matches.slice(0, limit ?? DEFAULT_RESULT_LIMIT);
    let text = shown.length
      ? shown.map((t) => `${renderLine(t)}  (${t.Path.slice(0, -1).join(" > ") || "top level"})`).join("\n")
      : "no matching tasks";
    if (shown.length < matches.length) {
      text += `\n… showing ${shown.length} of ${matches.length} matches — narrow the filters or raise limit`;
    }
    return textResult(text, { tasks: shown.map(toSummary), total: matches.length });
  },
});

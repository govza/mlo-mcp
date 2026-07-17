import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchTasks, renderLine } from "../task-tree.js";
import { guard, textResult, toSummary, TaskSummarySchema, type ToolContext } from "./shared.js";

export function registerSearchTasks(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_tasks",
    {
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
        minImportance: z.number().min(0).max(100).optional(),
      },
      outputSchema: { tasks: z.array(TaskSummarySchema), total: z.number() },
      annotations: { readOnlyHint: true },
    },
    guard("search_tasks", async (filters) => {
      const snap = await ctx.store.getSnapshot();
      const matches = searchTasks(snap.tasks, filters);
      const text = matches.length
        ? matches.map((t) => `${renderLine(t)}  (${t.Path.slice(0, -1).join(" > ") || "top level"})`).join("\n")
        : "no matching tasks";
      return textResult(text, { tasks: matches.map(toSummary), total: matches.length });
    })
  );
}

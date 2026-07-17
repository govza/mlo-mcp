import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findById, flatten, renderTasks } from "../task-tree.js";
import { guard, textResult, errorResult, toSummary, TaskSummarySchema, type ToolContext } from "./shared.js";

export function registerListTasks(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List the MyLifeOrganized task tree (or a subtree). Returns a text outline plus structured task data. " +
        "Ids are path-based (\"1.2.3\") and shift when the tree changes — treat them as valid only for immediate follow-up calls.",
      inputSchema: {
        format: z.enum(["tree", "flat"]).optional().describe("tree (indented outline, default) or flat"),
        includeCompleted: z.boolean().optional().describe("Include completed tasks (default false)"),
        parentId: z.string().optional().describe("Only list the subtree under this task id"),
        maxDepth: z.number().int().min(1).optional().describe("Limit outline depth"),
      },
      outputSchema: { tasks: z.array(TaskSummarySchema) },
      annotations: { readOnlyHint: true },
    },
    guard("list_tasks", async ({ format, includeCompleted, parentId, maxDepth }) => {
      const snap = await ctx.store.getSnapshot();
      let tasks = snap.tasks;
      if (parentId) {
        const parent = findById(snap.tasks, parentId);
        if (!parent) return errorResult(`no task with id "${parentId}" — call list_tasks or search_tasks first`);
        tasks = parent.Children;
      }
      const visible = flatten(tasks).filter((t) => includeCompleted || !t.CompletionDateTime);
      const text = renderTasks(tasks, { format, includeCompleted, maxDepth });
      return textResult(text, { tasks: visible.map(toSummary) });
    })
  );
}

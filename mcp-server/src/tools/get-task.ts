import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findById } from "../task-tree.js";
import { guard, textResult, errorResult, toSummary, TaskSummarySchema, type ToolContext } from "./shared.js";

export function registerGetTask(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_task",
    {
      title: "Get task details",
      description: "Full details of one task by id, including note, estimates, schedule fields and child tasks.",
      inputSchema: { id: z.string().describe('Path-based id from list_tasks/search_tasks, e.g. "1.2.3"') },
      outputSchema: {
        task: TaskSummarySchema.extend({
          Note: z.string().optional(),
          Effort: z.number().optional(),
          CompletionDateTime: z.string().optional(),
          EstimateMin: z.number().optional().describe("fractional days"),
          EstimateMax: z.number().optional().describe("fractional days"),
          LeadTime: z.number().optional().describe("days"),
          HideInToDo: z.boolean().optional(),
          CompleteSubTasksInOrder: z.boolean().optional(),
          children: z.array(z.object({ id: z.string(), Caption: z.string() })),
        }),
      },
      annotations: { readOnlyHint: true },
    },
    guard("get_task", async ({ id }) => {
      const snap = await ctx.store.getSnapshot();
      const t = findById(snap.tasks, id);
      if (!t) return errorResult(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
      const task = {
        ...toSummary(t),
        Note: t.Note,
        Effort: t.Effort,
        CompletionDateTime: t.CompletionDateTime,
        EstimateMin: t.EstimateMin,
        EstimateMax: t.EstimateMax,
        LeadTime: t.LeadTime,
        HideInToDo: t.HideInToDo,
        CompleteSubTasksInOrder: t.CompleteSubTasksInOrder,
        children: t.Children.map((c) => ({ id: c.id, Caption: c.Caption })),
      };
      const lines = [
        `[${t.id}] ${t.Caption}`,
        t.Guid ? `guid: ${t.Guid}` : "guid: (not recoverable)",
        `path: ${t.Path.join(" > ")}`,
        t.Note ? `note: ${t.Note}` : undefined,
        t.DueDateTime ? `due: ${t.DueDateTime}` : undefined,
        t.CompletionDateTime ? `completed: ${t.CompletionDateTime}` : undefined,
        t.Places.length ? `contexts: ${t.Places.join(", ")}` : undefined,
        t.Children.length ? `children: ${t.Children.map((c) => `[${c.id}] ${c.Caption}`).join(", ")}` : undefined,
      ].filter(Boolean);
      return textResult(lines.join("\n"), { task });
    })
  );
}

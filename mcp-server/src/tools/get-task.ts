import { z } from "zod";
import { TaskSummarySchema, toSummary } from "../task-summary.js";
import { defineTool, textResult, errorResult, PATH_ID_CAVEAT } from "./contract.js";

export const getTaskTool = defineTool({
  name: "get_task",
  title: "Get task details",
  description: "Full details of one task by id, including note, estimates, schedule fields and child tasks.",
  inputSchema: {
    id: z.string().describe(`Path-based id from list_tasks/search_tasks, e.g. "1.2.3"; ${PATH_ID_CAVEAT}`),
  },
  outputSchema: {
    task: TaskSummarySchema.extend({
      Note: z.string().optional(),
      Effort: z.number().optional(),
      CompletionDateTime: z.string().optional(),
      EstimateMin: z.number().optional().describe("fractional days"),
      EstimateMax: z.number().optional().describe("fractional days"),
      LeadTime: z.number().optional().describe("days"),
      HideInToDo: z.boolean().optional(),
      HideInToDoThisTask: z.boolean().optional().describe("true = folder-style task (hidden from to-do views itself)"),
      CompleteSubTasksInOrder: z.boolean().optional(),
      children: z.array(z.object({ id: z.string(), Caption: z.string() })),
      dependsOn: z
        .array(z.object({ id: z.string().optional(), Caption: z.string().optional(), uid: z.string() }))
        .describe("Tasks this task waits for"),
      dependedOnBy: z.array(z.object({ id: z.string(), Caption: z.string() })).describe("Tasks waiting for this task"),
    }),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute({ id }, ctx) {
    const detail = await ctx.outline.get(id);
    if (!detail) return errorResult(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
    const { task: t, uid: resolvedUid, dependsOn, dependedOnBy } = detail;
    const task = {
      ...toSummary(t),
      Guid: resolvedUid,
      Note: t.Note,
      Effort: t.Effort,
      CompletionDateTime: t.CompletionDateTime,
      EstimateMin: t.EstimateMin,
      EstimateMax: t.EstimateMax,
      LeadTime: t.LeadTime,
      HideInToDo: t.HideInToDo,
      HideInToDoThisTask: t.HideInToDoThisTask,
      CompleteSubTasksInOrder: t.CompleteSubTasksInOrder,
      children: t.Children.map((c) => ({ id: c.id, Caption: c.Caption })),
      dependsOn,
      dependedOnBy,
    };
    const lines = [
      `[${t.id}] ${t.Caption}`,
      resolvedUid ? `guid: ${resolvedUid}` : "guid: (not recoverable)",
      `path: ${t.Path.join(" > ")}`,
      t.Note ? `note: ${t.Note}` : undefined,
      t.DueDateTime ? `due: ${t.DueDateTime}` : undefined,
      t.CompletionDateTime ? `completed: ${t.CompletionDateTime}` : undefined,
      t.Places.length ? `contexts: ${t.Places.join(", ")}` : undefined,
      t.Children.length ? `children: ${t.Children.map((c) => `[${c.id}] ${c.Caption}`).join(", ")}` : undefined,
      dependsOn.length
        ? `depends on: ${dependsOn.map((d) => (d.id ? `[${d.id}] ${d.Caption}` : `unresolved ${d.uid}`)).join(", ")}`
        : undefined,
      dependedOnBy.length ? `depended on by: ${dependedOnBy.map((d) => `[${d.id}] ${d.Caption}`).join(", ")}` : undefined,
    ].filter(Boolean);
    return textResult(lines.join("\n"), { task });
  },
});

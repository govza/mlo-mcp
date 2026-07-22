import { z } from "zod";
import { findById, flatten } from "../task-tree.js";
import { defineTool, textResult, errorResult, toSummary, TaskSummarySchema, resolveReadCloudState } from "./shared.js";
import { knownCloudProjection, resolveTaskUid } from "../cloud/log-projection.js";
import type { TaskNode } from "../types.js";

export const getTaskTool = defineTool({
  name: "get_task",
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
    const snap = await ctx.store.getSnapshot();
    const t = findById(snap.tasks, id);
    if (!t) return errorResult(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
    const all = flatten(snap.tasks);
    const cloud = await knownCloudProjection(await resolveReadCloudState(ctx));
    const uidFor = (task: TaskNode) => task.Guid?.toUpperCase() ?? resolveTaskUid(task, cloud.rows);
    const resolvedUid = uidFor(t);
    const byGuid = new Map<string, TaskNode>();
    for (const task of all) {
      const uid = uidFor(task);
      if (uid) byGuid.set(uid, task);
    }
    const dependsOn = t.DependsOn.map((uid) => {
      const dep = byGuid.get(uid.toUpperCase());
      return { id: dep?.id, Caption: dep?.Caption, uid };
    });
    const dependedOnBy = all
      .filter((x) => resolvedUid && x.DependsOn.map((uid) => uid.toUpperCase()).includes(resolvedUid))
      .map((x) => ({ id: x.id, Caption: x.Caption }));
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

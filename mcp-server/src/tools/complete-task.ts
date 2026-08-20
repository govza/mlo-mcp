import { z } from "zod";
import { WRITE_ACCEPT_OUTPUT, acceptResult } from "./accepted.js";
import { defineTool, PATH_ID_CAVEAT } from "./contract.js";

const ID = z
  .string()
  .describe(`Path-based id from list_tasks/search_tasks ("1.2.3"), or the task's stable "{GUID}"; ${PATH_ID_CAVEAT}`);

export const completeTaskTool = defineTool({
  name: "complete_task",
  title: "Complete a task",
  description:
    "Mark one task completed (projects also get their project status closed). Recurring tasks are refused — " +
    "completing one in MLO spawns the next occurrence and this write would silently end the series; complete it " +
    "in the app instead. Returns once MLO applied it, or at durable accept if MLO could not sync inside the wait.",
  inputSchema: { id: ID },
  outputSchema: WRITE_ACCEPT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async execute({ id }, ctx) {
    return acceptResult(await ctx.outline.complete(id), `completing [${id}]`);
  },
});

export const uncompleteTaskTool = defineTool({
  name: "uncomplete_task",
  title: "Reopen a task",
  description:
    "Clear one task's completion. Allowed on recurring tasks: reopening generates no occurrence, so there is no " +
    "app behaviour for this write to bypass. Returns once MLO applied it, or at durable accept if MLO could not sync inside the wait.",
  inputSchema: { id: ID },
  outputSchema: WRITE_ACCEPT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async execute({ id }, ctx) {
    return acceptResult(await ctx.outline.uncomplete(id), `reopening [${id}]`);
  },
});

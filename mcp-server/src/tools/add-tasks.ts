import { z } from "zod";
import { TASK_FIELDS } from "./add-task.js";
import { WRITE_ACCEPT_OUTPUT, acceptResult } from "./accepted.js";
import { defineTool, PATH_ID_CAVEAT } from "./contract.js";

/**
 * A whole outline in one write. `key`/`parentKey` are batch-local names — they
 * mean nothing outside this call — which is what lets a caller nest tasks that
 * have no ids yet, and depend on siblings that do not exist yet either.
 */
const TaskEntry = z.object({
  ...TASK_FIELDS,
  key: z.string().min(1).optional().describe("Batch-local name for this task, referenced by parentKey/dependsOnKeys"),
  parentKey: z.string().min(1).optional().describe("key of another task in this batch — nest without needing ids"),
  parentId: z
    .string()
    .optional()
    .describe(
      `Path-based id of an existing parent from list_tasks/search_tasks (${PATH_ID_CAVEAT}); ` +
        "mutually exclusive with parentKey, omit both for top level",
    ),
  dependsOnKeys: z.array(z.string()).max(25).optional().describe("keys of tasks in this batch this one waits for"),
  dependsOnIds: z
    .array(z.string())
    .max(25)
    .optional()
    .describe(`Path ids of existing tasks this one waits for (${PATH_ID_CAVEAT})`),
});

export const addTasksTool = defineTool({
  name: "add_tasks",
  title: "Add several tasks",
  description:
    "Create 1–50 tasks as ONE write — a whole nested outline, in input order. Atomic: one bad entry and nothing " +
    "is queued. Returns once MLO applied it (or at durable accept if MLO could not sync inside the wait); reads show the tasks immediately, flagged pending.",
  inputSchema: {
    tasks: z.array(TaskEntry).min(1).max(50).describe("The tasks to create; input order is sibling order"),
  },
  outputSchema: WRITE_ACCEPT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async execute({ tasks }, ctx) {
    return acceptResult(await ctx.outline.addMany(tasks), `${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
  },
});

import { z } from "zod";
import { renderVisible } from "../task-tree.js";
import { TaskSummarySchema, toSummary } from "../task-summary.js";
import { defineTool, textResult, failureResult, DEFAULT_RESULT_LIMIT, PATH_ID_CAVEAT } from "./contract.js";

export const listTasksTool = defineTool({
  name: "list_tasks",
  title: "List tasks",
  description:
    "List the MyLifeOrganized task tree (or a subtree). Returns a text outline plus structured task data. " +
    "Ids are path-based (\"1.2.3\") and shift when the tree changes — treat them as valid only for immediate follow-up calls. " +
    `On large profiles, narrow with parentId/maxDepth instead of raising limit (default ${DEFAULT_RESULT_LIMIT}).`,
  inputSchema: {
    format: z.enum(["tree", "flat"]).optional().describe("tree (indented outline, default) or flat"),
    includeCompleted: z.boolean().optional().describe("Include completed tasks (default false)"),
    parentId: z.string().optional()
      .describe(`Only list the subtree under this Path-based task id; ${PATH_ID_CAVEAT}`),
    maxDepth: z.number().int().min(1).optional().describe("Limit outline depth"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Max tasks to return (default ${DEFAULT_RESULT_LIMIT}); the output notes when truncated`),
  },
  outputSchema: {
    tasks: z.array(TaskSummarySchema),
    total: z.number().describe("Visible tasks before the limit was applied"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute({ format, includeCompleted, parentId, maxDepth, limit }, ctx) {
    const result = await ctx.outline.list({ parentId, includeCompleted, maxDepth });
    if (result.isErrored) return failureResult(result.failure);
    const listing = result.value;
    const shown = listing.entries.slice(0, limit ?? DEFAULT_RESULT_LIMIT);
    let text = renderVisible(shown, format);
    if (shown.length < listing.total) {
      text += `\n… showing ${shown.length} of ${listing.total} tasks — narrow with parentId/maxDepth or raise limit`;
    }
    return textResult(text, { tasks: shown.map((e) => toSummary(e.task)), total: listing.total });
  },
});

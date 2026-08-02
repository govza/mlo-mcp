import { z } from "zod";
import { renderLine } from "../task-tree.js";
import { TaskSummaryShape, toSummary } from "../task-summary.js";
import { defineTool, textResult, failureResult, DEFAULT_RESULT_LIMIT } from "./contract.js";

const NextActionSchema = z.object({
  ...TaskSummaryShape,
  score: z.number().describe("MLO computed-score priority the list is sorted by (highest first)"),
  blocks: z
    .array(z.object({ kind: z.string(), detail: z.string() }))
    .optional()
    .describe("Why the action is deferred; present only when availableOnly is false"),
});

export const listNextActionsTool = defineTool({
  name: "list_next_actions",
  title: "List next actions",
  description:
    "The To-Do list MLO computes from the outline: actionable tasks only, ranked by priority. " +
    "Folders, hidden branches, tasks waiting behind a complete-in-order sibling and tasks blocked " +
    "by dependencies never appear; overdue tasks always do. By default only actions available right " +
    "now are returned — pass availableOnly: false to also see deferred ones (future start date, " +
    "closed context, open dependency) with the reason on each.",
  inputSchema: {
    context: z
      .string()
      .optional()
      .describe('Context name, e.g. "@Office" or "Office"; hierarchical, a parent context includes its children'),
    maxTimeMin: z
      .number()
      .min(1)
      .optional()
      .describe("Only actions that fit this many minutes; tasks with no time estimate always fit"),
    maxEffort: z
      .number()
      .min(0)
      .max(200)
      .optional()
      .describe("0–200 effort ceiling; 100 = normal, which is what tasks without an explicit Effort count as"),
    availableOnly: z
      .boolean()
      .optional()
      .describe("Default true; false also returns deferred actions annotated with their blocks"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Max actions to return (default ${DEFAULT_RESULT_LIMIT}); the output notes when truncated`),
  },
  outputSchema: {
    actions: z.array(NextActionSchema),
    total: z.number().describe("Matching actions before the limit was applied"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute({ limit, ...query }, ctx) {
    const result = await ctx.nextActions.nextActions(query);
    if (result.isErrored) return failureResult(result.failure);
    const matches = result.value;
    const shown = matches.slice(0, limit ?? DEFAULT_RESULT_LIMIT);
    let text = shown.length
      ? shown
          .map((a) => {
            const line = `${renderLine(a.task)}  (${a.task.Path.slice(0, -1).join(" > ") || "top level"})`;
            return a.available ? line : `${line}\n  deferred: ${a.blocks.map((b) => b.detail).join("; ")}`;
          })
          .join("\n")
      : "no next actions match";
    if (shown.length < matches.length) {
      text += `\n… showing ${shown.length} of ${matches.length} actions — narrow the filters or raise limit`;
    }
    return textResult(text, {
      actions: shown.map((a) => ({
        ...toSummary(a.task),
        score: a.score,
        ...(a.available ? {} : { blocks: a.blocks }),
      })),
      total: matches.length,
    });
  },
});

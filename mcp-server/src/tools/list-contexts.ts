import { z } from "zod";
import { defineTool, textResult, failureResult } from "./contract.js";

export const listContextsTool = defineTool({
  name: "list_contexts",
  title: "List contexts",
  description:
    "List the profile's contexts (MLO Places, e.g. @Office): the ones defined in the profile plus any " +
    "referenced by tasks, with usage counts. Consult this before assigning contexts — reuse existing ones.",
  inputSchema: {},
  outputSchema: {
    contexts: z.array(
      z.object({
        Caption: z.string(),
        defined: z.boolean().describe("Declared in the profile's places list (may carry open-hours schedules)"),
        tasksUsing: z.number(),
      })
    ),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute(_args, ctx) {
    const result = await ctx.outline.contexts();
    if (result.isErrored) return failureResult(result.failure);
    const contexts = result.value;
    const text = contexts.length
      ? contexts
          .map((c) => `${c.Caption}  (${c.tasksUsing} task${c.tasksUsing === 1 ? "" : "s"}${c.defined ? "" : ", not in places list"})`)
          .join("\n")
      : "(no contexts defined)";
    return textResult(text, { contexts });
  },
});

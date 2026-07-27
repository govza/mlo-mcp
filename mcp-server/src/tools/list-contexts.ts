import { z } from "zod";
import { defineTool, textResult } from "./contract.js";

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
    const contexts = await ctx.outline.contexts();
    const text = contexts.length
      ? contexts
          .map((c) => `${c.Caption}  (${c.tasksUsing} task${c.tasksUsing === 1 ? "" : "s"}${c.defined ? "" : ", not in places list"})`)
          .join("\n")
      : "(no contexts defined)";
    return textResult(text, { contexts });
  },
});

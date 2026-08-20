import { z } from "zod";
import { WRITE_ACCEPT_OUTPUT, acceptResult } from "./accepted.js";
import { defineTool, PATH_ID_CAVEAT } from "./contract.js";

export const moveTaskTool = defineTool({
  name: "move_task",
  title: "Move a task",
  description:
    "Re-parent one task, taking its whole subtree with it, optionally into a specific slot among its new " +
    "siblings. Moving a task into its own subtree is refused. Returns once MLO applied it, or at durable accept if MLO could not sync inside the wait.",
  inputSchema: {
    id: z
      .string()
      .describe(`Path-based id or stable "{GUID}" of the task to move (${PATH_ID_CAVEAT})`),
    newParentId: z
      .string()
      .optional()
      .describe(
        `Path-based id or stable "{GUID}" of the new parent (${PATH_ID_CAVEAT}); "" or omitted moves it to the top level`,
      ),
    position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("0-based slot among the new siblings (0 = first); omitted or past the end appends after them"),
  },
  outputSchema: WRITE_ACCEPT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async execute({ id, newParentId, position }, ctx) {
    return acceptResult(await ctx.outline.move(id, newParentId, position), `moving [${id}]`);
  },
});

import { z } from "zod";
import { WRITE_ACCEPT_OUTPUT, acceptResult } from "./accepted.js";
import { defineTool } from "./contract.js";

export const captureTaskTool = defineTool({
  name: "capture_task",
  title: "Capture a thought",
  description:
    "Rapid entry: one line in, one task in MLO's inbox out (top level when the profile has no inbox). The tool " +
    "for a thought that should not have to be filed before it is written down.",
  inputSchema: {
    line: z
      .string()
      .min(1)
      .describe(
        "The caption, optionally ending in @context tokens; anything after a blank line becomes the note. " +
          "Dates and importance are NOT parsed — they land in the caption verbatim, so pass them via add_task instead",
      ),
  },
  outputSchema: WRITE_ACCEPT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async execute({ line }, ctx) {
    return acceptResult(await ctx.outline.capture(line), "the captured task");
  },
});

import { z } from "zod";
import { defineTool, textResult, failureResult } from "./contract.js";

export const syncTool = defineTool({
  name: "sync",
  title: "Sync profile",
  description: "Run MLO QuickSync for the data file (cloud/Wi-Fi sync as configured in the profile).",
  inputSchema: {},
  outputSchema: { ok: z.boolean() },
  // openWorldHint: QuickSync talks to the MLO cloud / Wi-Fi sync endpoint.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async execute(_args, ctx) {
    const result = await ctx.admin.quickSync();
    if (result.isErrored) return failureResult(result.failure);
    return textResult("QuickSync finished", { ok: true });
  },
});

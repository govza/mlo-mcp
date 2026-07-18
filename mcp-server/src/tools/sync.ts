import { z } from "zod";
import { quickSync } from "../mlo-cli.js";
import { defineTool, textResult } from "./shared.js";

export const syncTool = defineTool({
  name: "sync",
  title: "Sync profile",
  description: "Run MLO QuickSync for the data file (cloud/Wi-Fi sync as configured in the profile).",
  inputSchema: {},
  outputSchema: { ok: z.boolean() },
  // openWorldHint: QuickSync talks to the MLO cloud / Wi-Fi sync endpoint.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async execute(_args, ctx) {
    await quickSync(ctx.config);
    ctx.store.invalidate();
    return textResult("QuickSync finished", { ok: true });
  },
});

import { z } from "zod";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { defineTool, textResult } from "./shared.js";

export const cloudStatusTool = defineTool({
  name: "cloud_status",
  title: "Local cloud sync status",
  description: "Report local cloud endpoint configuration, cursor, and delta counts.",
  inputSchema: {},
  outputSchema: {
    host: z.string(),
    port: z.number(),
    cursor: z.string(),
    entries: z.object({ mcp: z.number(), app: z.number() }),
    pendingForApp: z.number(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute(_args, ctx) {
    const [cursor, entries, pendingForApp] = await Promise.all([
      ctx.cloudState.highWater(),
      ctx.cloudState.counts(),
      ctx.cloudState.pendingFor("app"),
    ]);
    const result = {
      host: ctx.config.cloudHost,
      port: ctx.config.cloudPort,
      cursor: cursorToDecimalString(cursor),
      entries,
      pendingForApp,
    };
    return textResult(`Cloud endpoint ${result.host}:${result.port}; cursor ${result.cursor}; ${result.pendingForApp} pending for app.`, result);
  },
});

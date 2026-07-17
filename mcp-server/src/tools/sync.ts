import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { quickSync } from "../mlo-cli.js";
import { guard, textResult, type ToolContext } from "./shared.js";

export function registerSync(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "sync",
    {
      title: "Sync profile",
      description: "Run MLO QuickSync for the data file (cloud/Wi-Fi sync as configured in the profile).",
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      annotations: { idempotentHint: true },
    },
    guard("sync", async () => {
      await quickSync(ctx.config);
      ctx.store.invalidate();
      return textResult("QuickSync finished", { ok: true });
    })
  );
}

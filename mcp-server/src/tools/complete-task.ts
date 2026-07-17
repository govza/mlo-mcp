import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findRawById, findById } from "../task-tree.js";
import { setRawField } from "../xml.js";
import { replaceDataFile } from "../write-pipeline.js";
import { guard, textResult, errorResult, nowIso, type ToolContext } from "./shared.js";

export function registerCompleteTask(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description:
        "Mark a task completed (sets CompletionDateTime; for projects also ProjectStatus). " +
        "Rewrites the data file — a timestamped backup is kept next to it. Requires the MLO app to be closed.",
      inputSchema: { id: z.string().describe("Path-based task id from list_tasks/search_tasks") },
      outputSchema: { ok: z.boolean(), completedAt: z.string(), backupPath: z.string() },
      annotations: { destructiveHint: true },
    },
    guard("complete_task", async ({ id }) => {
      const completedAt = nowIso();
      let caption = "";
      const { backupPath } = await replaceDataFile(
        ctx.config,
        (doc) => {
          const found = findRawById(doc, id);
          if (!found) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
          caption = found.raw["@_Caption"];
          setRawField(found.raw, "CompletionDateTime", completedAt);
          if (found.raw.IsProject === "-1") setRawField(found.raw, "ProjectStatus", "3");
        },
        (after) => findById(after, id)?.CompletionDateTime === completedAt
      );
      ctx.store.invalidate();
      return textResult(`completed [${id}] "${caption}" at ${completedAt} (backup: ${backupPath})`, {
        ok: true,
        completedAt,
        backupPath,
      });
    })
  );
}

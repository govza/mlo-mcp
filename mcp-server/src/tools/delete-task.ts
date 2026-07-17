import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findRawById, flatten } from "../task-tree.js";
import { rootNode, type RawTaskNode } from "../xml.js";
import { replaceDataFile } from "../write-pipeline.js";
import { guard, textResult, type ToolContext } from "./shared.js";

export function registerDeleteTask(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description:
        "Permanently delete a task AND all of its subtasks. Rewrites the data file (timestamped backup kept — " +
        "restore it to undo). Requires the MLO app to be closed.",
      inputSchema: { id: z.string().describe("Path-based task id from list_tasks/search_tasks") },
      outputSchema: { ok: z.boolean(), deletedCaption: z.string(), deletedSubtasks: z.number(), backupPath: z.string() },
      annotations: { destructiveHint: true },
    },
    guard("delete_task", async ({ id }) => {
      let caption = "";
      let subtaskCount = 0;
      let expectedTotal = -1;
      const countTree = (n: RawTaskNode): number => (n.TaskNode ?? []).reduce((acc, c) => acc + 1 + countTree(c), 0);
      const { backupPath } = await replaceDataFile(
        ctx.config,
        (doc) => {
          const found = findRawById(doc, id);
          if (!found) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
          caption = found.raw["@_Caption"];
          subtaskCount = countTree(found.raw);
          expectedTotal = countTree(rootNode(doc)) - (subtaskCount + 1);
          found.siblings.splice(found.index, 1);
        },
        (after) => flatten(after).length === expectedTotal
      );
      ctx.store.invalidate();
      return textResult(
        `deleted [${id}] "${caption}" (${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}); backup: ${backupPath}`,
        { ok: true, deletedCaption: caption, deletedSubtasks: subtaskCount, backupPath }
      );
    })
  );
}

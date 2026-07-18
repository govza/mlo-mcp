import { z } from "zod";
import { findRawById, findById } from "../task-tree.js";
import { setRawField } from "../xml.js";
import { replaceDataFile } from "../write-pipeline.js";
import { defineTool, textResult } from "./shared.js";

export const uncompleteTaskTool = defineTool({
  name: "uncomplete_task",
  title: "Reopen tasks",
  description:
    "Reopen one or more completed tasks (clears CompletionDateTime; a project marked completed goes back to " +
    "active). All ids are applied in ONE write — batch related reopens, because every write rewrites the data " +
    "file (timestamped backup kept) and restarts the MLO app if it is open. Atomic: one bad id and nothing changes.",
  inputSchema: {
    ids: z.array(z.string()).min(1).max(50).describe("Path-based task ids from list_tasks/search_tasks (include completed tasks in the listing to see them)"),
  },
  outputSchema: {
    ok: z.boolean(),
    reopened: z.array(z.object({ id: z.string(), Caption: z.string() })),
    backupPath: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async execute({ ids }, ctx) {
    const unique = [...new Set(ids)];
    const reopened: Array<{ id: string; Caption: string }> = [];
    const { backupPath } = await replaceDataFile(
      ctx.config,
      (doc) => {
        const found = unique.map((id) => {
          const hit = findRawById(doc, id);
          if (!hit) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
          return { id, hit };
        });
        for (const { id, hit } of found) {
          reopened.push({ id, Caption: hit.raw["@_Caption"] });
          setRawField(hit.raw, "CompletionDateTime", undefined);
          // complete_task sets ProjectStatus 3 (completed); absent = default/active
          if (hit.raw.ProjectStatus === "3") setRawField(hit.raw, "ProjectStatus", undefined);
        }
      },
      (after) => unique.every((id) => findById(after, id)?.CompletionDateTime === undefined)
    );
    ctx.store.invalidate();
    const listText = reopened.map((c) => `[${c.id}] "${c.Caption}"`).join(", ");
    return textResult(`reopened ${listText} (backup: ${backupPath})`, { ok: true, reopened, backupPath });
  },
});

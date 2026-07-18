import { z } from "zod";
import { findRawById, findById } from "../task-tree.js";
import { setRawField } from "../xml.js";
import { replaceDataFile } from "../write-pipeline.js";
import { defineTool, textResult, nowIso } from "./shared.js";

export const completeTaskTool = defineTool({
  name: "complete_task",
  title: "Complete tasks",
  description:
    "Mark one or more tasks completed (sets CompletionDateTime; for projects also ProjectStatus). " +
    "All ids are applied in ONE write — batch related completions instead of calling per task, because " +
    "every write rewrites the data file (timestamped backup kept) and restarts the MLO app if it is open. " +
    "The batch is atomic: one bad id and nothing is changed.",
  inputSchema: {
    ids: z.array(z.string()).min(1).max(50).describe("Path-based task ids from list_tasks/search_tasks"),
  },
  outputSchema: {
    ok: z.boolean(),
    completedAt: z.string(),
    completed: z.array(z.object({ id: z.string(), Caption: z.string() })),
    backupPath: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async execute({ ids }, ctx) {
    const unique = [...new Set(ids)];
    const completedAt = nowIso();
    const completed: Array<{ id: string; Caption: string }> = [];
    const { backupPath } = await replaceDataFile(
      ctx.config,
      (doc) => {
        // Resolve every id before mutating so one bad id aborts the whole batch.
        const found = unique.map((id) => {
          const hit = findRawById(doc, id);
          if (!hit) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
          return { id, hit };
        });
        for (const { id, hit } of found) {
          completed.push({ id, Caption: hit.raw["@_Caption"] });
          setRawField(hit.raw, "CompletionDateTime", completedAt);
          if (hit.raw.IsProject === "-1") setRawField(hit.raw, "ProjectStatus", "3");
        }
      },
      // completion changes no structure, so path ids stay valid in the re-export
      (after) => unique.every((id) => findById(after, id)?.CompletionDateTime === completedAt)
    );
    ctx.store.invalidate();
    const listText = completed.map((c) => `[${c.id}] "${c.Caption}"`).join(", ");
    return textResult(`completed ${listText} at ${completedAt} (backup: ${backupPath})`, {
      ok: true,
      completedAt,
      completed,
      backupPath,
    });
  },
});

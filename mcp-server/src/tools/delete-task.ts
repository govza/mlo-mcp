import { z } from "zod";
import { findRawById, flatten } from "../task-tree.js";
import { rootNode, type RawTaskNode } from "../xml.js";
import { replaceDataFile } from "../write-pipeline.js";
import { defineTool, textResult } from "./shared.js";

export const deleteTaskTool = defineTool({
  name: "delete_task",
  title: "Delete tasks",
  description:
    "Permanently delete one or more tasks AND all of their subtasks. All ids are applied in ONE write — batch " +
    "related deletions, because every write rewrites the data file (timestamped backup kept — restore it to undo) " +
    "and restarts the MLO app if it is open. Atomic: one bad id and nothing is deleted.",
  inputSchema: {
    ids: z.array(z.string()).min(1).max(50).describe("Path-based task ids from list_tasks/search_tasks"),
  },
  outputSchema: {
    ok: z.boolean(),
    deleted: z.array(z.object({ id: z.string(), Caption: z.string(), subtasks: z.number() })),
    backupPath: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async execute({ ids }, ctx) {
    const unique = [...new Set(ids)];
    const deleted: Array<{ id: string; Caption: string; subtasks: number }> = [];
    let expectedTotal = -1;
    const countTree = (n: RawTaskNode): number => (n.TaskNode ?? []).reduce((acc, c) => acc + 1 + countTree(c), 0);
    const contains = (root: RawTaskNode, target: RawTaskNode): boolean =>
      (root.TaskNode ?? []).some((c) => c === target || contains(c, target));
    const { backupPath } = await replaceDataFile(
      ctx.config,
      (doc) => {
        // Resolve every id up front: splicing shifts sibling indexes, so later
        // path-id lookups against a half-mutated doc would hit wrong tasks.
        const found = unique.map((id) => {
          const hit = findRawById(doc, id);
          if (!hit) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
          return { id, hit };
        });
        // Drop ids nested under another selected id — the ancestor's deletion
        // already removes them (and double-splicing would corrupt the count).
        const roots = found.filter(({ hit }) => !found.some((o) => o.hit !== hit && contains(o.hit.raw, hit.raw)));
        expectedTotal = countTree(rootNode(doc)) - roots.reduce((acc, { hit }) => acc + countTree(hit.raw) + 1, 0);
        for (const { id, hit } of roots) {
          deleted.push({ id, Caption: hit.raw["@_Caption"], subtasks: countTree(hit.raw) });
          hit.siblings.splice(hit.siblings.indexOf(hit.raw), 1);
        }
      },
      (after) => flatten(after).length === expectedTotal
    );
    ctx.store.invalidate();
    const listText = deleted
      .map((d) => `[${d.id}] "${d.Caption}" (${d.subtasks} subtask${d.subtasks === 1 ? "" : "s"})`)
      .join(", ");
    return textResult(`deleted ${listText}; backup: ${backupPath}`, { ok: true, deleted, backupPath });
  },
});

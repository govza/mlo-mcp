import { z } from "zod";
import { buildTaskDeleteDelta } from "../cloud/delta.js";
import { packEnvelope } from "../cloud/envelope.js";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { quickSync } from "../mlo-cli.js";
import { findById, flatten } from "../task-tree.js";
import { defineTool, textResult } from "./shared.js";
import type { TaskNode } from "../types.js";
import { knownCloudProjection, resolveTaskUid } from "../cloud/log-projection.js";

export interface TombstoneSelection {
  targets: Array<{ id: string; task: TaskNode }>;
  uids: string[];
  missingGuid: TaskNode[];
}

/**
 * Resolve path ids to the GUID set to tombstone: each selected task plus every
 * descendant. The observed delete experiment (docs/mlo/cloud-sync.md) only
 * covered a childless task, so whether MLO's merge cascades a parent tombstone
 * to children is unknown — explicit descendant tombstones are emitted instead,
 * and union merging makes them harmless if MLO does cascade.
 */
export function collectTombstones(
  tasks: TaskNode[],
  ids: readonly string[],
  resolveUid: (task: TaskNode) => string | undefined = (task) => task.Guid,
): TombstoneSelection {
  const targets = [...new Set(ids)].map((id) => {
    const task = findById(tasks, id);
    if (!task) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
    return { id, task };
  });
  const uids = new Set<string>();
  const missingGuid = new Set<TaskNode>();
  for (const { task } of targets) {
    for (const node of flatten([task])) {
      const uid = resolveUid(node);
      if (uid) uids.add(uid.toUpperCase());
      else missingGuid.add(node);
    }
  }
  return { targets, uids: [...uids], missingGuid: [...missingGuid] };
}

/**
 * A tombstoned task counts as deleted only on positive evidence of removal.
 *
 * Identity must be resolved the same way the tombstones were targeted: a task
 * reachable only through the cloud log carries no Guid in the export, so
 * matching on Guid alone cannot see it and its absence from the match set is
 * not evidence it is gone. That vacuous pass is why a queued-but-unapplied
 * delete could report success. The tree must also have actually shrunk by the
 * tombstoned subtree size — under-reporting here is safe (the caller says
 * "queued, not applied yet"), over-reporting is not.
 */
export function wereTasksDeleted(
  before: TaskNode[],
  after: TaskNode[],
  uids: readonly string[],
  resolveUid: (task: TaskNode) => string | undefined = (task) => task.Guid,
): boolean {
  const present = new Set<string>();
  for (const task of flatten(after)) {
    const uid = resolveUid(task);
    if (uid) present.add(uid.toUpperCase());
  }
  if (uids.some((uid) => present.has(uid.toUpperCase()))) return false;
  return flatten(before).length - flatten(after).length >= uids.length;
}

export const deleteTaskTool = defineTool({
  name: "delete_task",
  title: "Delete tasks",
  description:
    "Queue tombstone deltas for one or more tasks AND all of their subtasks, trigger QuickSync, and verify they " +
    "disappeared from a fresh export. The whole batch travels as ONE delta. Requires every task in the selected " +
    "subtrees to have a GUID recoverable from binary/XML or an unambiguous logged cloud path; otherwise nothing " +
    "is queued — delete such tasks in the MLO app.",
  inputSchema: {
    ids: z.array(z.string()).min(1).max(50).describe("Path-based task ids from list_tasks/search_tasks"),
  },
  outputSchema: {
    uids: z.array(z.string()),
    cursor: z.string(),
    verified: z.boolean(),
    message: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  async execute({ ids }, ctx) {
    // Unlike add_task, the pre-sync export is mandatory: it is the only
    // source for the path-id → GUID resolution the tombstones are made of.
    const before = (await ctx.store.getSnapshot(true)).tasks;
    const cloud = await knownCloudProjection(ctx.cloudState);
    const { targets, uids, missingGuid } = collectTombstones(
      before,
      ids,
      (task) => task.Guid?.toUpperCase() ?? resolveTaskUid(task, cloud.rows),
    );
    if (missingGuid.length > 0) {
      const list = missingGuid.map((task) => `[${task.id}] "${task.Caption}"`).join(", ");
      throw new Error(
        `no recoverable GUID for ${list} — nothing was queued (a partial subtree tombstone could orphan children); ` +
          "delete these in the MLO app"
      );
    }
    const delta = buildTaskDeleteDelta(uids);
    const cursor = cursorToDecimalString(await ctx.cloudState.append("mcp", packEnvelope(delta)));
    const described = targets.map(({ id, task }) => `[${id}] "${task.Caption}"`).join(", ");
    let verified = false;
    let message: string;
    try {
      await quickSync(ctx.config);
      ctx.store.invalidate();
      try {
        const after = (await ctx.store.getSnapshot(true)).tasks;
        verified = wereTasksDeleted(before, after, uids, (task) =>
          task.Guid?.toUpperCase() ?? resolveTaskUid(task, cloud.rows),
        );
        message = verified
          ? `Deletion of ${described} was queued and no tombstoned task remains in a fresh MLO export.`
          : `Deletion of ${described} was queued, but at least one tombstoned task is still present in the fresh export after QuickSync.`;
      } catch (error) {
        message = `Deletion of ${described} was queued, but verification failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } catch (error) {
      ctx.store.invalidate();
      message = `Deletion of ${described} was queued for the next session, but QuickSync failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return textResult(message, { uids, cursor, verified, message });
  },
});

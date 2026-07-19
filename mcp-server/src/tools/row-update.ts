import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildTaskUpdatesDelta } from "../cloud/delta.js";
import { packEnvelope } from "../cloud/envelope.js";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { knownFullRows, type KnownRow } from "../cloud/log-projection.js";
import { quickSync } from "../mlo-cli.js";
import { findById, flatten } from "../task-tree.js";
import { nowIso, textResult, type ToolContext } from "./shared.js";
import type { TaskNode } from "../types.js";

export interface CloudRowTarget {
  id: string;
  task: TaskNode;
  uid: string;
  known: KnownRow;
}

export interface CloudRowUpdatePlan {
  /** Leads the human message: "<verb> of [1] "x" was queued …" */
  verb: string;
  /** Runs once after target resolution, before guards — e.g. to resolve move destinations against the same snapshot. */
  prepare?(before: TaskNode[], targets: CloudRowTarget[]): void;
  /** Throw to abort the whole batch before anything is queued. */
  guard?(target: CloudRowTarget): void;
  patchFor(target: CloudRowTarget, now: string): Record<string, string>;
  /** Post-QuickSync check on the target as found by GUID in a fresh export. */
  verified(task: TaskNode, target: CloudRowTarget): boolean;
}

/**
 * Shared queue → QuickSync → verify loop for cloud tools that rewrite a full
 * task row. All targets must resolve to a GUID (the export recovers these
 * best-effort) AND to a full row in the delta log — a row authored from any
 * lesser source would blank the columns that source cannot see.
 */
export async function runCloudRowUpdate(
  ctx: ToolContext,
  ids: readonly string[],
  plan: CloudRowUpdatePlan
): Promise<CallToolResult> {
  // The pre-sync export is mandatory: it is the only path-id → GUID resolver.
  const before = (await ctx.store.getSnapshot(true)).tasks;
  const resolved = [...new Set(ids)].map((id) => {
    const task = findById(before, id);
    if (!task) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
    return { id, task };
  });
  const noGuid = resolved.filter(({ task }) => !task.Guid);
  if (noGuid.length > 0) {
    const list = noGuid.map(({ id, task }) => `[${id}] "${task.Caption}"`).join(", ");
    throw new Error(`no recoverable GUID for ${list} — nothing was queued; make this change in the MLO app`);
  }
  const rows = await knownFullRows(ctx.cloudState);
  const targets: CloudRowTarget[] = resolved.map(({ id, task }) => {
    const uid = task.Guid!.toUpperCase();
    const known = rows.get(uid);
    if (!known) {
      throw new Error(
        `no full record for [${id}] "${task.Caption}" in the delta log — the cloud path can only rewrite tasks it has ` +
          "seen a complete row for (added via a cloud tool, or changed in MLO since the local endpoint took over); " +
          "nothing was queued; make this change in the MLO app"
      );
    }
    return { id, task, uid, known };
  });
  plan.prepare?.(before, targets);
  for (const target of targets) plan.guard?.(target);

  const now = nowIso();
  const delta = buildTaskUpdatesDelta(
    targets.map((target) => ({ header: target.known.header, row: target.known.row, patch: plan.patchFor(target, now) }))
  );
  const cursor = cursorToDecimalString(await ctx.cloudState.append("mcp", packEnvelope(delta)));
  const described = targets.map(({ id, task }) => `[${id}] "${task.Caption}"`).join(", ");
  const uids = targets.map((target) => target.uid);
  let verified = false;
  let message: string;
  try {
    await quickSync(ctx.config);
    ctx.store.invalidate();
    try {
      const after = flatten((await ctx.store.getSnapshot(true)).tasks);
      const byGuid = new Map(after.filter((task) => task.Guid).map((task) => [task.Guid!.toUpperCase(), task]));
      verified = targets.every((target) => {
        const task = byGuid.get(target.uid);
        return task !== undefined && plan.verified(task, target);
      });
      message = verified
        ? `${plan.verb} of ${described} was queued and verified in a fresh MLO export.`
        : `${plan.verb} of ${described} was queued, but a fresh export after QuickSync does not confirm every task yet.`;
    } catch (error) {
      message = `${plan.verb} of ${described} was queued, but verification failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } catch (error) {
    ctx.store.invalidate();
    message = `${plan.verb} of ${described} was queued for the next session, but QuickSync failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return textResult(message, { uids, cursor, verified, message });
}

/** CSV booleans in observed rows are numeric strings; anything non-empty and non-"0" is true. */
export function csvTruthy(value: string): boolean {
  return value !== "" && value !== "0";
}

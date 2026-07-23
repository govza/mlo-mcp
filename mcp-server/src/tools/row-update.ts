import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildTaskUpdatesDelta } from "../cloud/delta.js";
import { packEnvelope } from "../cloud/envelope.js";
import { knownCloudProjection, type KnownCloudProjection, type KnownRow } from "../cloud/log-projection.js";
import { buildUidResolver } from "../cloud/structure-align.js";
import { quickSync } from "../mlo-cli.js";
import { findById, flatten } from "../task-tree.js";
import { nowIso, requireWriteChannel, textResult, type ToolContext } from "./shared.js";
import type { TaskNode } from "../types.js";

export interface CloudRowTarget {
  id: string;
  task: TaskNode;
  uid: string;
  known: KnownRow;
  placeUids: string[];
  dependencyUids: string[];
}

export interface CloudRowUpdatePlan {
  /** Leads the human message: "<verb> of [1] "x" was queued …" */
  verb: string;
  /** Runs once after target resolution, before guards — e.g. to resolve move destinations against the same snapshot. */
  prepare?(before: TaskNode[], targets: CloudRowTarget[], cloud: KnownCloudProjection): void;
  /** Throw to abort the whole batch before anything is queued. */
  guard?(target: CloudRowTarget): void;
  patchFor(target: CloudRowTarget, now: string): Record<string, string>;
  /** Override the complete current Places relation set for a target. */
  placeUidsFor?(target: CloudRowTarget): readonly string[];
  /** Override the complete current dependency relation set for a target. */
  dependencyUidsFor?(target: CloudRowTarget): readonly string[];
  /** Emit a starred manual-order row when the operation explicitly stars a task. */
  starredOrderIndexFor?(target: CloudRowTarget): string | undefined;
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
  const channel = await requireWriteChannel(ctx);
  // The pre-sync export supplies path ids; GUIDs come from binary/XML first,
  // then conservatively from the logged Caption/ParentUID path.
  const before = (await ctx.store.getSnapshot(true)).tasks;
  const cloud = await knownCloudProjection(channel.state);
  const resolveUid = buildUidResolver(before, cloud);
  const resolved = [...new Set(ids)].map((id) => {
    const task = findById(before, id);
    if (!task) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
    return { id, task, uid: resolveUid(task) };
  });
  const noGuid = resolved.filter(({ uid }) => !uid);
  if (noGuid.length > 0) {
    const list = noGuid.map(({ id, task }) => `[${id}] "${task.Caption}"`).join(", ");
    throw new Error(`no recoverable GUID for ${list} — nothing was queued; make this change in the MLO app`);
  }
  const targets: CloudRowTarget[] = resolved.map(({ id, task, uid }) => {
    const resolvedUid = uid!;
    const known = cloud.rows.get(resolvedUid);
    if (!known) {
      throw new Error(
        `no full record for [${id}] "${task.Caption}" in the delta log — the cloud path can only rewrite tasks it has ` +
          "seen a complete row for (added via a cloud tool, or changed in MLO since the local endpoint took over); " +
          "nothing was queued; make this change in the MLO app"
      );
    }
    return {
      id, task, uid: resolvedUid, known,
      placeUids: cloud.placeUidsByTask.get(resolvedUid) ?? [],
      dependencyUids: cloud.dependencyUidsByTask.get(resolvedUid) ?? [],
    };
  });
  const placeCaptionByUid = new Map(cloud.places.map((place) => [place.uid, place.caption]));
  for (const target of targets) {
    const loggedPlaces = target.placeUids.map((uid) => placeCaptionByUid.get(uid)).filter((value): value is string => value !== undefined);
    const expectedPlaces = [...target.task.Places].sort((a, b) => a.localeCompare(b));
    const actualPlaces = [...loggedPlaces].sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(expectedPlaces) !== JSON.stringify(actualPlaces)) {
      throw new Error(
        `context relation state for [${target.id}] "${target.task.Caption}" is not fully recoverable from the delta log — ` +
          "nothing was queued; change this task once in MLO and sync"
      );
    }
    const expectedDependencies = [...target.task.DependsOn].map((uid) => uid.toUpperCase()).sort();
    const actualDependencies = [...target.dependencyUids].sort();
    if (JSON.stringify(expectedDependencies) !== JSON.stringify(actualDependencies)) {
      throw new Error(
        `dependency relation state for [${target.id}] "${target.task.Caption}" is not fully recoverable from the delta log — ` +
          "nothing was queued; change this task once in MLO and sync"
      );
    }
  }
  plan.prepare?.(before, targets, cloud);
  for (const target of targets) plan.guard?.(target);

  const now = nowIso();
  const delta = buildTaskUpdatesDelta(
    targets.map((target) => {
      const starredOrderIndex = plan.starredOrderIndexFor?.(target);
      return {
        header: target.known.header,
        row: target.known.row,
        patch: plan.patchFor(target, now),
        placeUids: plan.placeUidsFor?.(target) ?? target.placeUids,
        dependencyUids: plan.dependencyUidsFor?.(target) ?? target.dependencyUids,
        ...(starredOrderIndex !== undefined ? { starredOrderIndex } : {}),
      };
    })
  );
  const cursor = await channel.commit(packEnvelope(delta));
  const described = targets.map(({ id, task }) => `[${id}] "${task.Caption}"`).join(", ");
  const uids = targets.map((target) => target.uid);
  let verified = false;
  let message: string;
  try {
    await quickSync(ctx.config);
    ctx.store.invalidate();
    try {
      const afterRoots = (await ctx.store.getSnapshot(true)).tasks;
      const after = flatten(afterRoots);
      const verificationCloud = await knownCloudProjection(channel.state);
      const verifyUid = buildUidResolver(afterRoots, verificationCloud);
      const byGuid = new Map<string, TaskNode>();
      for (const task of after) {
        const uid = verifyUid(task);
        if (uid) byGuid.set(uid, task);
      }
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

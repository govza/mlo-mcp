import { z } from "zod";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { buildTaskAddDelta, generateGuid, mergeDeltas } from "../cloud/delta.js";
import { packEnvelope } from "../cloud/envelope.js";
import { knownCloudProjection, rowValue, type NamedCloudObject } from "../cloud/log-projection.js";
import { quickSync } from "../mlo-cli.js";
import { flatten } from "../task-tree.js";
import type { TaskNode } from "../types.js";
import { defineTool, nowIso, textResult } from "./shared.js";

const BatchTask = z.object({
  key: z.string().min(1).describe("Unique local key used by parentKey/dependsOnKeys within this call"),
  caption: z.string().min(1),
  note: z.string().optional(),
  dueDateTime: z.string().optional(),
  startDateTime: z.string().optional(),
  parentKey: z.string().optional().describe("Local key of another task in this batch"),
  parentUid: z.string().optional().describe("GUID of an existing parent; omit both parent fields for top level"),
  IsProject: z.boolean().optional(),
  Starred: z.boolean().optional(),
  Folder: z.boolean().optional(),
  HideInToDo: z.boolean().optional(),
  CompleteSubTasksInOrder: z.boolean().optional(),
  Flag: z.string().optional().describe("Existing flag caption"),
  Places: z.array(z.string().min(1)).max(25).optional().describe("Existing context captions"),
  dependsOnKeys: z.array(z.string()).max(25).optional().describe("Local keys in this batch that this task waits for"),
  dependsOnUids: z.array(z.string()).max(25).optional().describe("GUIDs of existing tasks that this task waits for"),
});
type BatchTaskSpec = z.infer<typeof BatchTask>;

function resolveNamed(caption: string, objects: readonly NamedCloudObject[], kind: string): string {
  const matches = objects.filter((object) => object.caption.toLocaleLowerCase() === caption.toLocaleLowerCase());
  if (matches.length === 0) throw new Error(`unknown ${kind} "${caption}" — use an existing ${kind}`);
  if (matches.length > 1) throw new Error(`ambiguous ${kind} "${caption}" — ${matches.length} definitions have that caption`);
  return matches[0]!.uid;
}

function validateGraph(specs: readonly BatchTaskSpec[], byKey: Map<string, BatchTaskSpec>): void {
  for (const spec of specs) {
    if (spec.parentKey !== undefined && spec.parentUid !== undefined) {
      throw new Error(`task "${spec.key}" cannot have both parentKey and parentUid`);
    }
    if (spec.parentKey !== undefined && !byKey.has(spec.parentKey)) {
      throw new Error(`task "${spec.key}" references unknown parentKey "${spec.parentKey}"`);
    }
    const relationKeys = spec.dependsOnKeys ?? [];
    if (new Set(relationKeys).size !== relationKeys.length) throw new Error(`task "${spec.key}" has duplicate dependsOnKeys`);
    for (const key of relationKeys) {
      if (!byKey.has(key)) throw new Error(`task "${spec.key}" references unknown dependsOnKey "${key}"`);
      if (key === spec.key) throw new Error(`task "${spec.key}" cannot depend on itself`);
    }
    const places = (spec.Places ?? []).map((place) => place.toLocaleLowerCase());
    if (new Set(places).size !== places.length) throw new Error(`task "${spec.key}" has duplicate Places`);
  }
  for (const spec of specs) {
    const seen = new Set<string>([spec.key]);
    let parentKey = spec.parentKey;
    while (parentKey !== undefined) {
      if (seen.has(parentKey)) throw new Error(`parentKey cycle involving "${spec.key}" and "${parentKey}"`);
      seen.add(parentKey);
      parentKey = byKey.get(parentKey)!.parentKey;
    }
  }
}

function signature(task: Pick<TaskNode, "Caption" | "Note">): string {
  return `${task.Caption}\u0000${task.Note ?? ""}`;
}

function countSignatures(tasks: readonly TaskNode[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const task of flatten([...tasks])) result.set(signature(task), (result.get(signature(task)) ?? 0) + 1);
  return result;
}

export const addTasksTool = defineTool({
  name: "add_tasks",
  title: "Add an atomic task outline",
  description:
    "Queue 1–50 new tasks as one atomic cloud delta. Local keys express arbitrary parent/child outlines and " +
    "within-batch dependencies; parentUid and dependsOnUids link to existing tasks by stable GUID.",
  inputSchema: {
    tasks: z.array(BatchTask).min(1).max(50).describe("Flat task definitions; input order is used as sibling order"),
  },
  outputSchema: {
    tasks: z.array(z.object({ key: z.string(), uid: z.string() })),
    cursor: z.string(),
    verified: z.boolean(),
    message: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async execute({ tasks }, ctx) {
    const byKey = new Map<string, BatchTaskSpec>();
    for (const spec of tasks) {
      if (byKey.has(spec.key)) throw new Error(`duplicate task key "${spec.key}"`);
      byKey.set(spec.key, spec);
    }
    validateGraph(tasks, byKey);
    const uids = new Map(tasks.map((spec) => [spec.key, generateGuid()]));
    const cloud = await knownCloudProjection(ctx.cloudState);
    let starredIndex = Math.max(0, ...[...cloud.starredOrderByTask.values()].map(Number).filter(Number.isFinite)) + 500;
    const maxItemIndexByParent = new Map<string, number>();
    for (const known of cloud.rows.values()) {
      const parentUid = rowValue(known, "ParentUID").toUpperCase();
      const itemIndex = Number(rowValue(known, "ItemIndex"));
      if (Number.isFinite(itemIndex)) maxItemIndexByParent.set(parentUid, Math.max(maxItemIndexByParent.get(parentUid) ?? 0, itemIndex));
    }
    const timestamp = nowIso();
    let before: TaskNode[] | undefined;
    try { before = (await ctx.store.getSnapshot(true)).tasks; } catch { /* verification remains best effort */ }

    const documents = tasks.map((spec) => {
      const existingDependencies = (spec.dependsOnUids ?? []).map((uid) => uid.toUpperCase());
      const batchDependencies = (spec.dependsOnKeys ?? []).map((key) => uids.get(key)!);
      const dependencyUids = [...existingDependencies, ...batchDependencies];
      if (new Set(dependencyUids).size !== dependencyUids.length) {
        throw new Error(`task "${spec.key}" has duplicate dependency targets`);
      }
      const starOrder = spec.Starred ? String(starredIndex) : undefined;
      if (spec.Starred) starredIndex += 500;
      const parentUid = spec.parentKey !== undefined ? uids.get(spec.parentKey)! : spec.parentUid;
      const parentKey = parentUid?.toUpperCase() ?? "";
      const itemIndex = (maxItemIndexByParent.get(parentKey) ?? 0) + 25;
      maxItemIndexByParent.set(parentKey, itemIndex);
      return buildTaskAddDelta({
        uid: uids.get(spec.key)!,
        parentUid,
        itemIndex: String(itemIndex),
        caption: spec.caption,
        createdDate: timestamp,
        lastModified: timestamp,
        ...(spec.note !== undefined ? { note: spec.note } : {}),
        ...(spec.dueDateTime !== undefined ? { dueDateTime: spec.dueDateTime } : {}),
        ...(spec.startDateTime !== undefined ? { startDateTime: spec.startDateTime } : {}),
        ...(spec.IsProject !== undefined ? { isProject: spec.IsProject } : {}),
        ...(spec.Starred !== undefined ? { starred: spec.Starred } : {}),
        ...(spec.Folder !== undefined ? { hideInToDoThisTask: spec.Folder } : {}),
        ...(spec.HideInToDo !== undefined ? { hideInToDo: spec.HideInToDo } : {}),
        ...(spec.CompleteSubTasksInOrder !== undefined ? { completeInOrder: spec.CompleteSubTasksInOrder } : {}),
        ...(spec.Flag !== undefined ? { flagUid: resolveNamed(spec.Flag, cloud.flags, "flag") } : {}),
        ...(spec.Places !== undefined
          ? { placeUids: spec.Places.map((place) => resolveNamed(place, cloud.places, "context")) }
          : {}),
        ...(dependencyUids.length ? { dependencyUids } : {}),
        ...(starOrder !== undefined ? { starredOrderIndex: starOrder } : {}),
      });
    });
    const cursor = cursorToDecimalString(await ctx.cloudState.append("mcp", packEnvelope(mergeDeltas(documents))));
    const resultTasks = tasks.map((spec) => ({ key: spec.key, uid: uids.get(spec.key)! }));
    let verified = false;
    let message: string;
    try {
      await quickSync(ctx.config);
      ctx.store.invalidate();
      try {
        const after = (await ctx.store.getSnapshot(true)).tasks;
        const afterFlat = flatten(after);
        const afterGuids = new Set(afterFlat.map((task) => task.Guid?.toUpperCase()).filter(Boolean));
        verified = resultTasks.every(({ uid }) => afterGuids.has(uid));
        if (!verified && before) {
          const beforeCounts = countSignatures(before);
          const afterCounts = countSignatures(after);
          const requested = new Map<string, number>();
          for (const spec of tasks) requested.set(signature({ Caption: spec.caption, Note: spec.note }), (requested.get(signature({ Caption: spec.caption, Note: spec.note })) ?? 0) + 1);
          verified = [...requested].every(([key, count]) => (afterCounts.get(key) ?? 0) - (beforeCounts.get(key) ?? 0) >= count);
        }
        message = verified
          ? `${tasks.length} tasks were queued atomically and verified in a fresh MLO export.`
          : `${tasks.length} tasks were queued atomically, but a fresh export does not confirm the whole outline yet.`;
      } catch (error) {
        message = `${tasks.length} tasks were queued atomically, but verification failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } catch (error) {
      ctx.store.invalidate();
      message = `${tasks.length} tasks were queued atomically for the next session, but QuickSync failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return textResult(message, { tasks: resultTasks, cursor, verified, message });
  },
});

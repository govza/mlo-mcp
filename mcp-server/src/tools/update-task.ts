import { z } from "zod";
import { randomUUID } from "node:crypto";
import { findRawById, findById, flatten, type FoundRaw } from "../task-tree.js";
import { setRawField, rootNode, type RawTaskNode } from "../xml.js";
import { replaceDataFile } from "../write-pipeline.js";
import { defineTool, textResult } from "./shared.js";


/** Delphi conventions: booleans serialize as "-1" when true and are absent when false. */
function applyField(raw: RawTaskNode, key: string, value: unknown): void {
  if (key === "Caption") {
    raw["@_Caption"] = String(value);
    return;
  }
  if (typeof value === "boolean") {
    setRawField(raw, key, value ? "-1" : undefined);
  } else if (typeof value === "number") {
    setRawField(raw, key, String(value));
  } else if (Array.isArray(value)) {
    // Places
    setRawField(raw, key, value.length ? { Place: value.map(String) } : undefined);
  } else {
    setRawField(raw, key, value === "" ? undefined : String(value));
  }
}

const UpdateEntry = z.object({
  id: z.string().describe("Path-based task id"),
  Caption: z.string().min(1).optional(),
  Note: z.string().optional(),
  Importance: z.number().min(0).max(200).optional().describe("0–200; 100 = normal"),
  Effort: z.number().min(0).max(200).optional(),
  DueDateTime: z
    .string()
    .optional()
    .describe(
      'ISO like "2026-08-01T15:00:00"; "" clears. CAUTION on recurring tasks: the recurrence pattern ' +
        "(Recurrence fields) is not updated — overwriting the due date can desync the series. Check get_task first."
    ),
  StartDateTime: z.string().optional(),
  CompletionDateTime: z.string().optional().describe('"" reopens a completed task (or use uncomplete_task)'),
  IsProject: z.boolean().optional(),
  ProjectStatus: z.number().int().optional(),
  Starred: z.boolean().optional(),
  Flag: z.string().optional().describe('e.g. "Green Flag"; "" clears'),
  Places: z.array(z.string()).optional().describe("Full replacement list of contexts"),
  EstimateMin: z.number().optional().describe("fractional days"),
  EstimateMax: z.number().optional(),
  TheGoal: z.number().int().min(0).max(3).optional().describe("0 none, 1 weekly, 2 monthly, 3 yearly"),
  moveToParentId: z
    .string()
    .optional()
    .describe('Re-parent: move this task (with its whole subtree) under the given task id; "" moves it to the top level'),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe(
      "Full replacement list of task ids this task depends on (waits for in to-do views); [] clears all dependencies"
    ),
  HideInToDo: z.boolean().optional().describe("Hide this task AND its whole branch from to-do views"),
  HideInToDoThisTask: z
    .boolean()
    .optional()
    .describe("Folder behavior: hide only this task from to-do views, children still show (true = make folder, false = make normal task)"),
  CompleteSubTasksInOrder: z.boolean().optional(),
});

interface EntryPlan {
  id: string;
  found: FoundRaw;
  fields: Array<[string, unknown]>;
  moveToParentId?: string;
  dependsOn?: string[];
  /** resolved at apply time */
  caption: string;
  destCaption?: string; // undefined = top level (when moving with "")
  moving: boolean;
  depCaptions: string[];
}

export const updateTaskTool = defineTool({
  name: "update_task",
  title: "Update tasks",
  description:
    "Edit fields of one or more tasks by id. Only provided fields change; pass an empty string to clear a text " +
    "field, false to clear a boolean, [] to clear contexts. All updates are applied in ONE write — batch related " +
    "edits instead of calling per task, because every write rewrites the data file (timestamped backup kept) and " +
    "restarts the MLO app if it is open. Atomic: one bad entry and nothing changes. All ids resolve against the " +
    "tree as it is BEFORE the call — a moveToParentId in one entry cannot target a position created by another.",
  inputSchema: {
    updates: z.array(UpdateEntry).min(1).max(25).describe("Per-task updates (max 25), applied in one write"),
  },
  outputSchema: {
    ok: z.boolean(),
    updated: z.array(z.object({ id: z.string(), Caption: z.string(), changes: z.array(z.string()) })),
    backupPath: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async execute({ updates }, ctx) {
    // Validate shape BEFORE the pipeline runs — a throw inside mutate() has
    // already closed the MLO GUI for nothing.
    const idsSeen = new Set<string>();
    const specs = updates.map(({ id, moveToParentId, dependsOn, ...fields }) => {
      if (idsSeen.has(id)) throw new Error(`duplicate id "${id}" in updates — merge those entries into one`);
      idsSeen.add(id);
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      const moving = moveToParentId !== undefined;
      if (entries.length === 0 && !moving && dependsOn === undefined) {
        throw new Error(`entry for id "${id}" has nothing to update — pass at least one field`);
      }
      return { id, moveToParentId, dependsOn, entries, moving };
    });
    const plans: EntryPlan[] = [];
    const { backupPath } = await replaceDataFile(
      ctx.config,
      (doc) => {
        // Phase 1 — resolve every id (targets, move destinations, dependency
        // targets) against the untouched doc. Moves change sibling indexes, so
        // resolving lazily against a half-mutated doc would hit wrong tasks.
        for (const { id, moveToParentId, dependsOn, entries, moving } of specs) {
          const found = findRawById(doc, id);
          if (!found) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
          plans.push({ id, found, fields: entries, moveToParentId, dependsOn, caption: "", moving, depCaptions: [] });
        }
        const destByEntry = new Map<EntryPlan, RawTaskNode[] | { dest: FoundRaw }>();
        for (const plan of plans) {
          if (!plan.moving) continue;
          if (plan.moveToParentId === "") {
            destByEntry.set(plan, rootNode(doc).TaskNode ??= []);
          } else {
            const dest = findRawById(doc, plan.moveToParentId!);
            if (!dest) throw new Error(`no task with id "${plan.moveToParentId}" to move under — re-run list_tasks`);
            destByEntry.set(plan, { dest });
          }
        }
        const depTargets = new Map<EntryPlan, FoundRaw[]>();
        for (const plan of plans) {
          if (!plan.dependsOn?.length) continue;
          depTargets.set(
            plan,
            plan.dependsOn.map((depId) => {
              const target = findRawById(doc, depId);
              if (!target) throw new Error(`dependsOn: no task with id "${depId}" — re-run list_tasks`);
              if (target.raw === plan.found.raw) throw new Error("a task cannot depend on itself");
              return target;
            })
          );
        }

        // Phase 2 — apply: fields and dependencies first, moves last.
        for (const plan of plans) {
          for (const [k, v] of plan.fields) applyField(plan.found.raw, k, v);
          plan.caption = plan.found.raw["@_Caption"];
          if (plan.dependsOn !== undefined) {
            if (plan.dependsOn.length === 0) {
              delete plan.found.raw.Dependency;
            } else {
              const uids: string[] = [];
              for (const target of depTargets.get(plan)!) {
                // the target must expose its GUID as <IDD> for the link to import
                target.raw.IDD ??= `{${randomUUID().toUpperCase()}}`;
                setRawField(target.raw, "IDD", target.raw.IDD);
                uids.push(target.raw.IDD);
                plan.depCaptions.push(target.raw["@_Caption"]);
              }
              setRawField(plan.found.raw, "Dependency", { UID: uids });
            }
          }
        }
        for (const plan of plans) {
          if (!plan.moving) continue;
          const dest = destByEntry.get(plan)!;
          let destSiblings: RawTaskNode[];
          if (Array.isArray(dest)) {
            destSiblings = dest; // top level
          } else {
            const inOwnSubtree = (n: RawTaskNode): boolean =>
              n === dest.dest.raw || (n.TaskNode ?? []).some(inOwnSubtree);
            if (inOwnSubtree(plan.found.raw)) {
              throw new Error(`cannot move [${plan.id}] "${plan.caption}" into its own subtree`);
            }
            plan.destCaption = dest.dest.raw["@_Caption"];
            destSiblings = dest.dest.raw.TaskNode ??= [];
          }
          // splice by identity: earlier moves may have shifted this array
          plan.found.siblings.splice(plan.found.siblings.indexOf(plan.found.raw), 1);
          destSiblings.push(plan.found.raw);
        }
      },
      (after) => {
        const all = flatten(after);
        const anyMove = plans.some((p) => p.moving);
        const byGuid = new Map(all.filter((t) => t.Guid).map((t) => [t.Guid!, t.Caption]));
        for (const plan of plans) {
          // After a move anywhere in the batch, path ids are stale — fall back
          // to caption matching (plus destination parent for moved entries).
          const target = plan.moving
            ? all.find(
                (t) => t.Caption === plan.caption && (plan.destCaption ? t.Path.at(-2) === plan.destCaption : t.Path.length === 1)
              )
            : anyMove
              ? all.find((t) => t.Caption === plan.caption)
              : findById(after, plan.id);
          if (!target || target.Caption !== plan.caption) return false;
          if (plan.dependsOn !== undefined) {
            // GUIDs are remapped on import — verify by resolving UIDs to captions
            const resolved = target.DependsOn.map((uid) => byGuid.get(uid)).filter(Boolean);
            if (resolved.length !== plan.dependsOn.length) return false;
            if (!plan.depCaptions.every((c) => resolved.includes(c))) return false;
          }
        }
        return true;
      }
    );
    ctx.store.invalidate();
    const updated = plans.map((plan) => {
      const changes = plan.fields.map(([k]) => k);
      if (plan.moving) changes.push(`moved ${plan.destCaption ? `under "${plan.destCaption}"` : "to top level"}`);
      if (plan.dependsOn !== undefined) {
        changes.push(
          plan.dependsOn.length ? `depends on: ${plan.depCaptions.map((c) => `"${c}"`).join(", ")}` : "dependencies cleared"
        );
      }
      return { id: plan.id, Caption: plan.caption, changes };
    });
    const text = updated.map((u) => `updated [${u.id}] "${u.Caption}": ${u.changes.join(", ")}`).join("\n");
    return textResult(`${text}\n(backup: ${backupPath})`, { ok: true, updated, backupPath });
  },
});

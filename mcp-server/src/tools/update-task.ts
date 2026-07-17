import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { findRawById, findById, flatten } from "../task-tree.js";
import { setRawField, rootNode, type RawTaskNode } from "../xml.js";
import { replaceDataFile } from "../write-pipeline.js";
import { guard, textResult, type ToolContext } from "./shared.js";


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

export function registerUpdateTask(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Edit fields of a task by id. Only provided fields change; pass an empty string to clear a text field, " +
        "false to clear a boolean, [] to clear contexts. Rewrites the data file (timestamped backup kept). " +
        "If the MLO app is open it is closed gracefully (it saves on close) and relaunched after the write.",
      inputSchema: {
        id: z.string().describe("Path-based task id"),
        Caption: z.string().min(1).optional(),
        Note: z.string().optional(),
        Importance: z.number().min(0).max(200).optional().describe("0–200; 100 = normal"),
        Effort: z.number().min(0).max(200).optional(),
        DueDateTime: z.string().optional().describe('ISO like "2026-08-01T15:00:00"; "" clears'),
        StartDateTime: z.string().optional(),
        CompletionDateTime: z.string().optional().describe('"" reopens a completed task'),
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
      },
      outputSchema: { ok: z.boolean(), updatedFields: z.array(z.string()), backupPath: z.string() },
      annotations: { destructiveHint: true },
    },
    guard("update_task", async ({ id, moveToParentId, dependsOn, ...fields }) => {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      const moving = moveToParentId !== undefined;
      if (entries.length === 0 && !moving && dependsOn === undefined) {
        return textResult("nothing to update — pass at least one field");
      }
      let caption = "";
      let destCaption: string | undefined; // undefined = top level
      const depCaptions: string[] = [];
      const { backupPath } = await replaceDataFile(
        ctx.config,
        (doc) => {
          const found = findRawById(doc, id);
          if (!found) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
          for (const [k, v] of entries) applyField(found.raw, k, v);
          caption = found.raw["@_Caption"];
          if (dependsOn !== undefined) {
            if (dependsOn.length === 0) {
              delete found.raw.Dependency;
            } else {
              const uids: string[] = [];
              for (const depId of dependsOn) {
                const target = findRawById(doc, depId);
                if (!target) throw new Error(`dependsOn: no task with id "${depId}" — re-run list_tasks`);
                if (target.raw === found.raw) throw new Error("a task cannot depend on itself");
                // the target must expose its GUID as <IDD> for the link to import
                target.raw.IDD ??= `{${randomUUID().toUpperCase()}}`;
                setRawField(target.raw, "IDD", target.raw.IDD);
                uids.push(target.raw.IDD);
                depCaptions.push(target.raw["@_Caption"]);
              }
              setRawField(found.raw, "Dependency", { UID: uids });
            }
          }
          if (moving) {
            let destSiblings: RawTaskNode[];
            if (moveToParentId === "") {
              destSiblings = rootNode(doc).TaskNode ??= [];
            } else {
              const dest = findRawById(doc, moveToParentId);
              if (!dest) throw new Error(`no task with id "${moveToParentId}" to move under — re-run list_tasks`);
              const inOwnSubtree = (n: RawTaskNode): boolean =>
                n === dest.raw || (n.TaskNode ?? []).some(inOwnSubtree);
              if (inOwnSubtree(found.raw)) {
                throw new Error("cannot move a task into its own subtree");
              }
              destCaption = dest.raw["@_Caption"];
              destSiblings = dest.raw.TaskNode ??= [];
            }
            found.siblings.splice(found.index, 1);
            destSiblings.push(found.raw);
          }
        },
        (after) => {
          const all = flatten(after);
          const target = moving
            ? all.find((t) => t.Caption === caption && (destCaption ? t.Path.at(-2) === destCaption : t.Path.length === 1))
            : findById(after, id);
          if (!target || target.Caption !== caption) return false;
          if (dependsOn !== undefined) {
            // GUIDs are remapped on import — verify by resolving UIDs to captions
            const byGuid = new Map(all.filter((t) => t.Guid).map((t) => [t.Guid!, t.Caption]));
            const resolved = target.DependsOn.map((uid) => byGuid.get(uid)).filter(Boolean);
            if (resolved.length !== dependsOn.length) return false;
            if (!depCaptions.every((c) => resolved.includes(c))) return false;
          }
          return true;
        }
      );
      ctx.store.invalidate();
      const names = entries.map(([k]) => k);
      if (moving) names.push(`moved ${destCaption ? `under "${destCaption}"` : "to top level"}`);
      if (dependsOn !== undefined) {
        names.push(dependsOn.length ? `depends on: ${depCaptions.map((c) => `"${c}"`).join(", ")}` : "dependencies cleared");
      }
      return textResult(`updated [${id}] "${caption}": ${names.join(", ")} (backup: ${backupPath})`, {
        ok: true,
        updatedFields: names,
        backupPath,
      });
    })
  );
}

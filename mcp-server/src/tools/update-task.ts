import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findRawById } from "../task-tree.js";
import { setRawField, type RawTaskNode } from "../xml.js";
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
    guard("update_task", async ({ id, ...fields }) => {
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return textResult("nothing to update — pass at least one field");
      let caption = "";
      const { backupPath } = await replaceDataFile(
        ctx.config,
        (doc) => {
          const found = findRawById(doc, id);
          if (!found) throw new Error(`no task with id "${id}" — ids shift when the tree changes; re-run list_tasks`);
          for (const [k, v] of entries) applyField(found.raw, k, v);
          caption = found.raw["@_Caption"];
        },
        // the same position must still hold a task; caption check catches gross misplacement
        (after) => {
          const parts = id.split(".").map(Number);
          let list = after;
          let node;
          for (let i = 0; i < parts.length; i++) {
            node = list[parts[i] - 1];
            if (!node) return false;
            list = node.Children;
          }
          return node!.Caption === caption;
        }
      );
      ctx.store.invalidate();
      const names = entries.map(([k]) => k);
      return textResult(`updated [${id}] "${caption}": ${names.join(", ")} (backup: ${backupPath})`, {
        ok: true,
        updatedFields: names,
        backupPath,
      });
    })
  );
}

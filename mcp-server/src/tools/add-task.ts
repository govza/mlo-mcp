import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addTask, isMloRunning } from "../mlo-cli.js";
import { findById, flatten } from "../task-tree.js";
import { rootNode, type RawTaskNode } from "../xml.js";
import { findRawById } from "../task-tree.js";
import { replaceDataFile } from "../write-pipeline.js";
import { guard, textResult, errorResult, toSummary, TaskSummarySchema, type ToolContext } from "./shared.js";

/** "2026-08-01", "2026-08-01T15:00", "2026-08-01T15:00:00" → full MLO ISO, else undefined */
function normalizeIso(s: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) return undefined;
  return `${m[1]}T${m[2] ?? "00:00"}:${m[3] ?? "00"}`;
}

/** GUI 1–5 scale → MLO's stored 0–200 scale */
const scale5 = (n: number) => String((n - 1) * 50);

export function registerAddTask(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "add_task",
    {
      title: "Add task",
      description:
        "Create a task. With the MLO app closed and an ISO dueDate (or none), fields are written exactly. " +
        "With the app open, or with a natural-language dueDate or parseText, the task goes through MLO's " +
        "rapid-entry parser instead — that parser is best-effort (captions containing digits can absorb " +
        "unparsed tokens), so always check the reported result.",
      inputSchema: {
        caption: z.string().min(1).describe("Task caption"),
        parentId: z.string().optional().describe("Place the task under this task id (default: top level / inbox)"),
        note: z.string().optional(),
        dueDate: z
          .string()
          .optional()
          .describe('ISO ("2026-08-01" or "2026-08-01T15:00") is applied exactly; natural language ("tomorrow 3pm") goes through MLO\'s parser'),
        startDate: z.string().optional().describe("ISO only; ignored on the parser path"),
        contexts: z.array(z.string()).optional().describe('Context names, e.g. ["@Office"]'),
        importance: z.number().int().min(1).max(5).optional().describe("1–5 (3 = normal; stored as (N-1)*50 on MLO's 0–200 scale)"),
        urgency: z.number().int().min(1).max(5).optional().describe("1–5; parser path only (no XML field)"),
        effort: z.number().int().min(1).max(5).optional(),
        starred: z.boolean().optional(),
        folder: z
          .boolean()
          .optional()
          .describe("Create as a folder: the task itself is hidden from to-do views, its children still show (MLO -f)"),
        flag: z.string().optional().describe('e.g. "Green Flag"'),
        parseText: z
          .string()
          .optional()
          .describe('Raw MLO parser tail appended verbatim, e.g. "remind tomorrow 9am -h -p" — forces the parser path'),
      },
      outputSchema: { task: TaskSummarySchema.optional(), placement: z.string(), method: z.enum(["xml", "parser"]) },
      annotations: {},
    },
    guard("add_task", async (input) => {
      const { caption, parentId, note, dueDate, startDate, contexts, importance, urgency, effort, starred, folder, flag, parseText } = input;

      const guiRunning = await isMloRunning();
      const isoDue = dueDate ? normalizeIso(dueDate) : undefined;
      const isoStart = startDate ? normalizeIso(startDate) : undefined;
      const needsParser = Boolean(parseText) || Boolean(urgency) || (dueDate !== undefined && !isoDue);

      let parentCaption: string | undefined;
      if (parentId) {
        const parent = findById((await ctx.store.getSnapshot()).tasks, parentId);
        if (!parent) return errorResult(`no task with id "${parentId}" — re-run list_tasks and retry`);
        parentCaption = parent.Caption;
      }

      let placement = parentCaption ? `under "${parentCaption}"` : "top level";
      let method: "xml" | "parser";

      if (!needsParser && !guiRunning) {
        // Deterministic path: insert the node straight into the XML round-trip.
        method = "xml";
        await replaceDataFile(
          ctx.config,
          (doc) => {
            let siblings: RawTaskNode[];
            if (parentId) {
              const found = findRawById(doc, parentId);
              if (!found) throw new Error(`no task with id "${parentId}" — re-run list_tasks and retry`);
              siblings = found.raw.TaskNode ??= [];
            } else {
              siblings = rootNode(doc).TaskNode ??= [];
            }
            const node: RawTaskNode = { "@_Caption": caption };
            if (note) node.Note = note;
            if (importance) node.Importance = scale5(importance);
            if (effort) node.Effort = scale5(effort);
            // MLO ignores a bare DueDateTime on import; its own exports always
            // write the Due/Start/LeadTime/ScheduleType quartet together.
            if (isoDue || isoStart) {
              if (isoDue) node.DueDateTime = isoDue;
              node.StartDateTime = isoStart ?? isoDue;
              node.LeadTime = "0";
              node.ScheduleType = "1";
            }
            if (starred) node.Starred = "-1";
            if (folder) node.HideInToDoThisTask = "-1";
            if (flag) node.Flag = flag;
            if (contexts?.length) node.Places = { Place: contexts.map((c) => (c.startsWith("@") ? c : `@${c}`)) };
            siblings.push(node);
          },
          (after) =>
            flatten(after).some(
              (t) =>
                t.Caption === caption &&
                (!parentCaption || t.Path.slice(0, -1).includes(parentCaption)) &&
                (!isoDue || t.DueDateTime === isoDue)
            )
        );
      } else {
        // Parser path: MLO rapid-entry syntax. Quotes shield the caption.
        method = "parser";
        const switches: string[] = [];
        if (dueDate && !isoDue) switches.push(dueDate);
        else if (isoDue) switches.push(isoDue.replace("T", " "));
        if (contexts?.length) switches.push(contexts.map((c) => (c.startsWith("@") ? c : `@${c}`)).join("; "));
        if (importance) switches.push(`-i${importance}`);
        if (urgency) switches.push(`-u${urgency}`);
        if (effort) switches.push(`-e${effort}`);
        if (starred) switches.push("-star");
        if (folder) switches.push("-f");
        if (flag) switches.push(`-fl${flag}`);
        if (parseText) switches.push(parseText);

        let parentGuid: string | undefined;
        if (parentId && parentCaption) {
          const parent = findById((await ctx.store.getSnapshot()).tasks, parentId);
          if (parent?.Guid && !guiRunning) {
            parentGuid = parent.Guid;
            placement += " via GUID";
          } else {
            switches.push(`-to${parentCaption}`);
            placement += " via name match";
          }
        }
        const usesParser = switches.length > 0;
        const arg = usesParser ? `"${caption}" ${switches.join(" ")}` : caption;
        await addTask(ctx.config, arg, { parentGuid, parse: usesParser });
      }

      ctx.store.invalidate();
      const snap = await ctx.store.getSnapshot(true);
      const created = flatten(snap.tasks)
        .filter((t) => t.Caption === caption || (method === "parser" && t.Caption.startsWith(caption)))
        .at(-1);
      const text = created
        ? `created [${created.id}] "${created.Caption}" (${placement}, ${method}); parent path: ${created.Path.slice(0, -1).join(" > ") || "(top)"}`
        : `task submitted (${placement}, ${method}) but not found in re-export under caption "${caption}" — check list_tasks`;
      return textResult(text, { task: created ? toSummary(created) : undefined, placement, method });
    })
  );
}

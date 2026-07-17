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

/** Indented outline ("2 spaces or 1 tab per level") → nested RawTaskNodes. */
export function parseOutline(outline: string): RawTaskNode[] {
  const roots: RawTaskNode[] = [];
  const stack: Array<{ depth: number; node: RawTaskNode }> = [];
  for (const line of outline.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^(\s*)(.*)$/.exec(line)!;
    const depth = Math.floor(m[1].replaceAll("\t", "  ").length / 2);
    const node: RawTaskNode = { "@_Caption": m[2].trim() };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) {
      (stack[stack.length - 1].node.TaskNode ??= []).push(node);
    } else {
      roots.push(node);
    }
    stack.push({ depth, node });
  }
  return roots;
}

function outlineCaptions(nodes: RawTaskNode[]): string[] {
  return nodes.flatMap((n) => [n["@_Caption"], ...outlineCaptions(n.TaskNode ?? [])]);
}

export function registerAddTask(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "add_task",
    {
      title: "Add task",
      description:
        "Create a task, optionally with a whole subtree in one call. MLO is an OUTLINER — deep nesting is " +
        "idiomatic, so prefer parentId placement and the subtasks outline over flat top-level lists. Fields and " +
        "placement are written exactly via the XML pipeline (if the MLO app is open it is closed gracefully — " +
        "it saves on close — and relaunched afterwards). Only a natural-language dueDate, urgency or parseText " +
        "route through MLO's best-effort rapid-entry parser; a bare caption is added instantly without touching " +
        "the app. Always check the reported result.",
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
        subtasks: z
          .string()
          .optional()
          .describe(
            "Indented outline of subtasks created under the new task in the same write — one caption per line, " +
              "2 spaces (or 1 tab) deeper = one level deeper. Arbitrary depth. Example:\n" +
              "Warm-up\nMain set\n  Intervals\n  Cooldown swim\nStretching"
          ),
      },
      outputSchema: { task: TaskSummarySchema.optional(), placement: z.string(), method: z.enum(["xml", "parser"]) },
      annotations: {},
    },
    guard("add_task", async (input) => {
      const { caption, parentId, note, dueDate, startDate, contexts, importance, urgency, effort, starred, folder, flag, parseText, subtasks } = input;

      const guiRunning = await isMloRunning();
      const isoDue = dueDate ? normalizeIso(dueDate) : undefined;
      const isoStart = startDate ? normalizeIso(startDate) : undefined;
      const needsParser = Boolean(parseText) || Boolean(urgency) || (dueDate !== undefined && !isoDue);
      const subtree = subtasks ? parseOutline(subtasks) : [];
      if (subtree.length && needsParser) {
        return errorResult(
          "subtasks require the exact XML path — use an ISO dueDate and drop urgency/parseText, " +
            "or create the parent first and add parser-based subtasks separately"
        );
      }

      let parentCaption: string | undefined;
      if (parentId) {
        const parent = findById((await ctx.store.getSnapshot()).tasks, parentId);
        if (!parent) return errorResult(`no task with id "${parentId}" — re-run list_tasks and retry`);
        parentCaption = parent.Caption;
      }

      let placement = parentCaption ? `under "${parentCaption}"` : "top level";
      let method: "xml" | "parser";

      // Exact XML insert whenever the parser isn't required. The -AddSubtask
      // IPC shortcut is only trustworthy with no GUI running: a running GUI
      // applies it to whatever row the user has selected, so with the GUI open
      // every parser-free add goes through the XML pipeline (which restarts
      // the app around the write).
      const hasFields = Boolean(
        note || isoDue || isoStart || contexts?.length || importance || effort || starred || folder || flag || parentId
      );
      const useXmlPath = (!needsParser && (guiRunning ? ctx.config.autoRestartGui : hasFields)) || subtree.length > 0;

      let guiRestarted = false;
      if (useXmlPath) {
        // Deterministic path: insert the node straight into the XML round-trip.
        method = "xml";
        ({ guiRestarted } = await replaceDataFile(
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
            if (subtree.length) node.TaskNode = subtree;
            siblings.push(node);
          },
          (after) => {
            const all = flatten(after);
            const parent = all.find(
              (t) =>
                t.Caption === caption &&
                (!parentCaption || t.Path.slice(0, -1).includes(parentCaption)) &&
                (!isoDue || t.DueDateTime === isoDue)
            );
            if (!parent) return false;
            const subtreeCaptions = new Set(flatten(parent.Children).map((t) => t.Caption));
            return outlineCaptions(subtree).every((c) => subtreeCaptions.has(c));
          }
        ));
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
      let snap = await ctx.store.getSnapshot(true);
      let created = flatten(snap.tasks)
        .filter((t) => t.Caption === caption || (method === "parser" && t.Caption.startsWith(caption)))
        .at(-1);

      // A running GUI applies -AddSubtask to whatever row the USER has selected
      // ("Add subtask to the selected task"), so an IPC add can land anywhere.
      // Detect that and move the task to where it was actually asked to go.
      let relocated = false;
      if (created && method === "parser") {
        const actualParent = created.Path.at(-2);
        const misplaced = parentCaption ? actualParent !== parentCaption : created.Path.length > 1;
        if (misplaced) {
          const movedCaption = created.Caption;
          {
            // Locate nodes by caption inside the pipeline's own export — the
            // GUI's close-save can shift path ids computed from the live view.
            const findLastByCaption = (
              siblings: RawTaskNode[],
              cap: string
            ): { siblings: RawTaskNode[]; index: number; raw: RawTaskNode } | undefined => {
              let hit: { siblings: RawTaskNode[]; index: number; raw: RawTaskNode } | undefined;
              for (let i = 0; i < siblings.length; i++) {
                const raw = siblings[i];
                if (raw["@_Caption"] === cap) hit = { siblings, index: i, raw };
                const deeper = findLastByCaption(raw.TaskNode ?? [], cap);
                if (deeper) hit = deeper;
              }
              return hit;
            };
            await replaceDataFile(
              ctx.config,
              (doc) => {
                const rootChildren = rootNode(doc).TaskNode ??= [];
                const found = findLastByCaption(rootChildren, movedCaption);
                if (!found) throw new Error("could not relocate the new task — it is missing from a fresh export");
                found.siblings.splice(found.index, 1);
                let destSiblings: RawTaskNode[];
                if (parentCaption) {
                  const dest = findLastByCaption(rootChildren, parentCaption);
                  if (!dest) throw new Error("could not find the requested parent to relocate the new task");
                  destSiblings = dest.raw.TaskNode ??= [];
                } else {
                  destSiblings = rootChildren;
                }
                destSiblings.push(found.raw);
              },
              (after) =>
                flatten(after).some(
                  (t) => t.Caption === movedCaption && (parentCaption ? t.Path.at(-2) === parentCaption : t.Path.length === 1)
                )
            );
            relocated = true;
            ctx.store.invalidate();
            snap = await ctx.store.getSnapshot(true);
            created = flatten(snap.tasks)
              .filter((t) => t.Caption === movedCaption)
              .at(-1);
          }
        }
      }

      const restartNote =
        (subtree.length ? ` with ${outlineCaptions(subtree).length} subtasks` : "") +
        (guiRestarted ? "; MLO was closed for the write and relaunched" : "") +
        (relocated ? "; the GUI had another task selected, so the new task was moved to the requested position" : "");
      const text = created
        ? `created [${created.id}] "${created.Caption}" (${placement}, ${method}); parent path: ${created.Path.slice(0, -1).join(" > ") || "(top)"}${restartNote}`
        : `task submitted (${placement}, ${method}) but not found in re-export under caption "${caption}" — check list_tasks`;
      return textResult(text, { task: created ? toSummary(created) : undefined, placement, method });
    })
  );
}

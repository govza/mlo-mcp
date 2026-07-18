import { z } from "zod";
import { addTask, isMloRunning } from "../mlo-cli.js";
import { findById, findInbox, findRawInbox, flatten } from "../task-tree.js";
import { rootNode, type RawTaskNode } from "../xml.js";
import { findRawById } from "../task-tree.js";
import { replaceDataFile } from "../write-pipeline.js";
import { defineTool, textResult, errorResult, toSummary, TaskSummarySchema, type ToolContext } from "./shared.js";
import type { TaskNode } from "../types.js";

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

/** Fields shared by the single-task input and batch entries (exact XML semantics). */
const XmlFields = {
  note: z.string().optional(),
  startDate: z.string().optional().describe("ISO only; ignored on the parser path"),
  contexts: z.array(z.string()).optional().describe('Context names, e.g. ["@Office"]'),
  importance: z.number().int().min(1).max(5).optional().describe("1–5 (3 = normal; stored as (N-1)*50 on MLO's 0–200 scale)"),
  effort: z.number().int().min(1).max(5).optional(),
  starred: z.boolean().optional(),
  folder: z
    .boolean()
    .optional()
    .describe("Create as a folder: the task itself is hidden from to-do views, its children still show (MLO -f)"),
  flag: z.string().optional().describe('e.g. "Green Flag"'),
  subtasks: z
    .string()
    .optional()
    .describe(
      "Indented outline of subtasks created under the new task in the same write — one caption per line, " +
        "2 spaces (or 1 tab) deeper = one level deeper. Arbitrary depth. Example:\n" +
        "Warm-up\nMain set\n  Intervals\n  Cooldown swim\nStretching"
    ),
};

const BatchEntry = z.object({
  caption: z.string().min(1).describe("Task caption"),
  parentId: z
    .string()
    .optional()
    .describe(
      'Place under this EXISTING task id; "root" forces top level. Default: the profile\'s <Inbox> node ' +
        "(top level if the profile has none). Batch entries cannot parent on each other — " +
        "use one entry's subtasks outline to create a new tree"
    ),
  dueDate: z.string().optional().describe('ISO only in batch mode ("2026-08-01" or "2026-08-01T15:00")'),
  ...XmlFields,
});
type BatchEntryT = z.infer<typeof BatchEntry>;

interface BuiltEntry {
  entry: BatchEntryT;
  isoDue?: string;
  isoStart?: string;
  parentCaption?: string;
  /** No parentId given and the profile has an inbox node — file the task there. */
  toInbox?: boolean;
  subtree: RawTaskNode[];
}

function buildNode({ entry, isoDue, isoStart, subtree }: BuiltEntry): RawTaskNode {
  const node: RawTaskNode = { "@_Caption": entry.caption };
  if (entry.note) node.Note = entry.note;
  if (entry.importance) node.Importance = scale5(entry.importance);
  if (entry.effort) node.Effort = scale5(entry.effort);
  // MLO ignores a bare DueDateTime on import; its own exports always
  // write the Due/Start/LeadTime/ScheduleType quartet together.
  if (isoDue || isoStart) {
    if (isoDue) node.DueDateTime = isoDue;
    node.StartDateTime = isoStart ?? isoDue;
    node.LeadTime = "0";
    node.ScheduleType = "1";
  }
  if (entry.starred) node.Starred = "-1";
  if (entry.folder) node.HideInToDoThisTask = "-1";
  if (entry.flag) node.Flag = entry.flag;
  if (entry.contexts?.length) node.Places = { Place: entry.contexts.map((c) => (c.startsWith("@") ? c : `@${c}`)) };
  if (subtree.length) node.TaskNode = subtree;
  return node;
}

/** One entry landed correctly in the re-export: caption under parent, due date, full subtree. */
function verifyEntry(all: TaskNode[], built: BuiltEntry): boolean {
  const hit = all.find(
    (t) =>
      t.Caption === built.entry.caption &&
      (!built.parentCaption || t.Path.slice(0, -1).includes(built.parentCaption)) &&
      (!built.isoDue || t.DueDateTime === built.isoDue)
  );
  if (!hit) return false;
  const subtreeCaptions = new Set(flatten(hit.Children).map((t) => t.Caption));
  return outlineCaptions(built.subtree).every((c) => subtreeCaptions.has(c));
}

async function executeBatch(entries: BatchEntryT[], ctx: ToolContext) {
  const built: BuiltEntry[] = [];
  for (const entry of entries) {
    const isoDue = entry.dueDate ? normalizeIso(entry.dueDate) : undefined;
    if (entry.dueDate && !isoDue) {
      return errorResult(
        `entry "${entry.caption}": dueDate "${entry.dueDate}" is not ISO — batch mode is exact-XML only; ` +
          "use single-task mode for natural-language dates"
      );
    }
    const isoStart = entry.startDate ? normalizeIso(entry.startDate) : undefined;
    built.push({ entry, isoDue, isoStart, subtree: entry.subtasks ? parseOutline(entry.subtasks) : [] });
  }
  const snapBefore = await ctx.store.getSnapshot();
  const inbox = findInbox(snapBefore.tasks, ctx.config.inboxCaption);
  for (const b of built) {
    if (b.entry.parentId === "root") continue;
    if (!b.entry.parentId) {
      if (inbox) {
        b.toInbox = true;
        b.parentCaption = inbox.Caption;
      }
      continue;
    }
    const parent = findById(snapBefore.tasks, b.entry.parentId);
    if (!parent) return errorResult(`entry "${b.entry.caption}": no task with id "${b.entry.parentId}" — re-run list_tasks`);
    b.parentCaption = parent.Caption;
  }

  const { guiRestarted, backupPath } = await replaceDataFile(
    ctx.config,
    (doc) => {
      // Resolve all parents before inserting: appends never shift existing
      // sibling indexes, but resolving first keeps id semantics uniform.
      const inserts = built.map((b) => {
        if (b.toInbox) {
          // Located by caption, not id: the write pipeline re-exports fresh.
          const rawInbox = findRawInbox(doc, ctx.config.inboxCaption);
          if (!rawInbox) throw new Error(`entry "${b.entry.caption}": the inbox node vanished between snapshot and write — retry`);
          return { b, siblings: (rawInbox.TaskNode ??= []) };
        }
        if (!b.entry.parentId || b.entry.parentId === "root") return { b, siblings: (rootNode(doc).TaskNode ??= []) };
        const found = findRawById(doc, b.entry.parentId);
        if (!found) throw new Error(`entry "${b.entry.caption}": no task with id "${b.entry.parentId}" — re-run list_tasks`);
        return { b, siblings: (found.raw.TaskNode ??= []) };
      });
      for (const { b, siblings } of inserts) siblings.push(buildNode(b));
    },
    (after) => {
      const all = flatten(after);
      return built.every((b) => verifyEntry(all, b));
    }
  );

  ctx.store.invalidate();
  const snap = await ctx.store.getSnapshot(true);
  const all = flatten(snap.tasks);
  const created = built.map((b) =>
    all
      .filter((t) => t.Caption === b.entry.caption && (!b.parentCaption || t.Path.slice(0, -1).includes(b.parentCaption)))
      .at(-1)
  );
  const lines = created.map((t, i) => {
    const b = built[i];
    if (!t) return `entry "${b.entry.caption}" written but not found in re-export`;
    const where = b.toInbox
      ? "inbox"
      : b.parentCaption
        ? `under "${b.parentCaption}"`
        : b.entry.parentId === "root"
          ? "top level"
          : "top level — no inbox node found in this profile";
    return `created [${t.id}] "${t.Caption}" (${where})`;
  });
  const restartNote = guiRestarted ? "\nMLO was closed for the write and relaunched" : "";
  return textResult(`${built.length} tasks in one write (backup: ${backupPath}):\n${lines.join("\n")}${restartNote}`, {
    tasks: created.filter(Boolean).map((t) => toSummary(t!)),
    placement: "batch",
    method: "xml" as const,
    backupPath,
  });
}

export const addTaskTool = defineTool({
  name: "add_task",
  title: "Add tasks",
  description:
    "Create a task — or several in one write via `tasks` — optionally each with a whole subtree. MLO is an " +
    "OUTLINER: deep nesting is idiomatic, so prefer parentId placement and the subtasks outline over flat " +
    "top-level lists. Fields and placement are written exactly via the XML pipeline (if the MLO app is open it " +
    "is closed gracefully — it saves on close — and relaunched afterwards); ALWAYS batch multiple adds into one " +
    "call (`tasks` or subtasks outline) instead of calling per task. Without a parentId, tasks are filed into " +
    "the profile's <Inbox> node for later processing (parentId \"root\" forces a deliberate top-level task). " +
    "Only a natural-language dueDate, urgency or " +
    "parseText route through MLO's best-effort rapid-entry parser (single-task mode only). Always check the " +
    "reported result.",
  inputSchema: {
    caption: z.string().min(1).optional().describe("Task caption (single-task mode; omit when using `tasks`)"),
    parentId: z
      .string()
      .optional()
      .describe('Place the task under this task id; "root" forces top level (default: the profile\'s <Inbox> node, else top level)'),
    dueDate: z
      .string()
      .optional()
      .describe('ISO ("2026-08-01" or "2026-08-01T15:00") is applied exactly; natural language ("tomorrow 3pm") goes through MLO\'s parser'),
    urgency: z.number().int().min(1).max(5).optional().describe("1–5; parser path only (no XML field)"),
    parseText: z
      .string()
      .optional()
      .describe('Raw MLO parser tail appended verbatim, e.g. "remind tomorrow 9am -h -p" — forces the parser path'),
    ...XmlFields,
    tasks: z
      .array(BatchEntry)
      .min(1)
      .max(25)
      .optional()
      .describe(
        "Batch mode: create up to 25 tasks (each with own parentId/fields/subtasks) in ONE data-file write. " +
          "Exact-XML only (ISO dates, no urgency/parseText). Mutually exclusive with the single-task fields."
      ),
  },
  outputSchema: {
    task: TaskSummarySchema.optional().describe("single-task mode"),
    tasks: z.array(TaskSummarySchema).optional().describe("batch mode"),
    placement: z.string(),
    method: z.enum(["xml", "parser"]),
    backupPath: z.string().optional().describe("batch mode: the data-file backup made for the write"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async execute(input, ctx) {
    const { caption, parentId, note, dueDate, startDate, contexts, importance, urgency, effort, starred, folder, flag, parseText, subtasks, tasks } = input;

    if (tasks) {
      const singles = [caption, parentId, note, dueDate, startDate, contexts, importance, urgency, effort, starred, folder, flag, parseText, subtasks];
      if (singles.some((v) => v !== undefined)) {
        return errorResult("`tasks` is mutually exclusive with the single-task fields — put per-task fields inside each entry");
      }
      return executeBatch(tasks, ctx);
    }
    if (!caption) return errorResult("pass a caption (single task) or `tasks` (batch)");

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

    let parent: TaskNode | undefined;
    let toInbox = false;
    if (parentId && parentId !== "root") {
      parent = findById((await ctx.store.getSnapshot()).tasks, parentId);
      if (!parent) return errorResult(`no task with id "${parentId}" — re-run list_tasks and retry`);
    } else if (!parentId) {
      // Unparented adds default into MLO's inbox node, like the GUI's rapid entry.
      parent = findInbox((await ctx.store.getSnapshot()).tasks, ctx.config.inboxCaption);
      toInbox = Boolean(parent);
    }
    const parentCaption = parent?.Caption;

    let placement = toInbox
      ? "inbox"
      : parentCaption
        ? `under "${parentCaption}"`
        : parentId === "root"
          ? "top level"
          : "top level — no inbox node found in this profile";
    let method: "xml" | "parser";

    // Exact XML insert whenever the parser isn't required. The -AddSubtask
    // IPC shortcut is only trustworthy with no GUI running: a running GUI
    // applies it to whatever row the user has selected, so with the GUI open
    // every parser-free add goes through the XML pipeline (which restarts
    // the app around the write).
    const hasFields = Boolean(
      note || isoDue || isoStart || contexts?.length || importance || effort || starred || folder || flag || parent
    );
    const useXmlPath = (!needsParser && (guiRunning ? ctx.config.autoRestartGui : hasFields)) || subtree.length > 0;

    let guiRestarted = false;
    if (useXmlPath) {
      // Deterministic path: insert the node straight into the XML round-trip.
      method = "xml";
      const built: BuiltEntry = {
        entry: { caption, note, contexts, importance, effort, starred, folder, flag },
        isoDue,
        isoStart,
        parentCaption,
        subtree,
      };
      ({ guiRestarted } = await replaceDataFile(
        ctx.config,
        (doc) => {
          let siblings: RawTaskNode[];
          if (toInbox) {
            // Located by caption, not id: the write pipeline re-exports fresh.
            const rawInbox = findRawInbox(doc, ctx.config.inboxCaption);
            if (!rawInbox) throw new Error("the inbox node vanished between snapshot and write — retry");
            siblings = rawInbox.TaskNode ??= [];
          } else if (parent && parentId) {
            const found = findRawById(doc, parentId);
            if (!found) throw new Error(`no task with id "${parentId}" — re-run list_tasks and retry`);
            siblings = found.raw.TaskNode ??= [];
          } else {
            siblings = rootNode(doc).TaskNode ??= [];
          }
          siblings.push(buildNode(built));
        },
        (after) => verifyEntry(flatten(after), built)
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
      if (parent) {
        if (parent.Guid && !guiRunning) {
          parentGuid = parent.Guid;
          placement += " via GUID";
        } else if (!toInbox) {
          switches.push(`-to${parentCaption}`);
          placement += " via name match";
        }
        // Inbox default without a usable GUID: the parser drops the task
        // wherever it lands and the relocation pass below moves it into the
        // inbox — "-to<Inbox>" is not worth risking on the parser's tokenizer.
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
  },
});

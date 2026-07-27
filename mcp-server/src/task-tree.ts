import type { RawTaskNode, MloDocument } from "./xml.js";
import { rootNode } from "./xml.js";
import type { TaskNode } from "./types.js";

/** Delphi boolean convention: -1 = true, absent/0 = false. */
function delphiBool(v: string | undefined): boolean | undefined {
  return v === undefined ? undefined : v === "-1";
}

function num(v: string | undefined): number | undefined {
  return v === undefined || v === "" ? undefined : Number(v);
}

function toModel(raw: RawTaskNode, id: string, parentPath: string[], depth: number): TaskNode {
  const path = [...parentPath, raw["@_Caption"]];
  const node: TaskNode = {
    id,
    Guid: raw.IDD,
    Caption: raw["@_Caption"],
    Note: raw.Note,
    Importance: num(raw.Importance),
    Effort: num(raw.Effort),
    DueDateTime: raw.DueDateTime,
    StartDateTime: raw.StartDateTime,
    CompletionDateTime: raw.CompletionDateTime,
    IsProject: delphiBool(raw.IsProject),
    ProjectStatus: num(raw.ProjectStatus),
    Starred: delphiBool(raw.Starred),
    Flag: raw.Flag,
    Places: raw.Places?.Place ?? [],
    EstimateMin: num(raw.EstimateMin),
    EstimateMax: num(raw.EstimateMax),
    TheGoal: num(raw.TheGoal),
    HideInToDo: delphiBool(raw.HideInToDo),
    HideInToDoThisTask: delphiBool(raw.HideInToDoThisTask),
    ScheduleType: num(raw.ScheduleType),
    LeadTime: num(raw.LeadTime),
    CompleteSubTasksInOrder: delphiBool(raw.CompleteSubTasksInOrder),
    DependsOn: raw.Dependency?.UID ?? [],
    Children: [],
    Path: path,
    Depth: depth,
  };
  node.Children = (raw.TaskNode ?? []).map((c, i) => toModel(c, `${id}.${i + 1}`, path, depth + 1));
  return node;
}

/** Build the model tree from a parsed export. Returns top-level tasks (root Caption="" excluded). */
export function buildTaskTree(doc: MloDocument): TaskNode[] {
  return (rootNode(doc).TaskNode ?? []).map((c, i) => toModel(c, String(i + 1), [], 0));
}

/**
 * A copy of the tree with the positional fields (`id`, `Path`, `Depth`)
 * re-derived from where each task now sits. The pending-write overlay inserts
 * phantom tasks, re-parents moved ones and hides deleted ones, and a path id
 * that no longer matches its position would resolve the next call onto the
 * wrong task. Pure, like the rest of this tier: the input tree is left alone.
 */
export function renumbered(tasks: readonly TaskNode[], parentPath: string[] = [], depth = 0, parentId = ""): TaskNode[] {
  return tasks.map((task, index) => {
    const id = parentId ? `${parentId}.${index + 1}` : String(index + 1);
    const Path = [...parentPath, task.Caption];
    return { ...task, id, Path, Depth: depth, Children: renumbered(task.Children, Path, depth + 1, id) };
  });
}

export function flatten(tasks: TaskNode[]): TaskNode[] {
  const out: TaskNode[] = [];
  const walk = (list: TaskNode[]) => {
    for (const t of list) {
      out.push(t);
      walk(t.Children);
    }
  };
  walk(tasks);
  return out;
}

export function findById(tasks: TaskNode[], id: string): TaskNode | undefined {
  return flatten(tasks).find((t) => t.id === id);
}

/**
 * MLO's inbox is an ordinary top-level task the GUI creates on first
 * rapid-entry capture, captioned literally "<Inbox>". That caption is the
 * identity: it is hardcoded in mlo.exe for every UI language (the .lng files
 * localize only the Inbox VIEW label) and the profile stores no other pointer
 * to the node. A plain "Inbox" is matched too for hand-made capture folders;
 * anything else needs the MLO_INBOX_CAPTION config override.
 */
const INBOX_CAPTIONS = ["<Inbox>", "Inbox"];

function inboxCaptions(configCaption?: string): string[] {
  return configCaption ? [configCaption, ...INBOX_CAPTIONS] : INBOX_CAPTIONS;
}

/** Marker check for outline rendering (canonical captions only, top level only). */
export function looksLikeInbox(t: TaskNode): boolean {
  return t.Depth === 0 && INBOX_CAPTIONS.includes(t.Caption);
}

export function findInbox(tasks: TaskNode[], configCaption?: string): TaskNode | undefined {
  for (const cap of inboxCaptions(configCaption)) {
    const hit = tasks.find((t) => t.Caption === cap);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The two kinds of container the outline itself declares: a **project**
 * (`IsProject`) and a **folder** — MLO's Folder flag, stored as
 * `HideInToDoThisTask`, a pure bucket that never appears in the To-Do list
 * even once everything under it is done
 * ([docs/mlo/mlo-task-model.md](../../docs/mlo/mlo-task-model.md) §3). One
 * owner for that flag-to-meaning mapping, so the availability engine and the
 * review queries cannot read it differently.
 */
export function containerKind(t: TaskNode): "project" | "folder" | undefined {
  if (t.IsProject) return "project";
  if (t.HideInToDoThisTask) return "folder";
  return undefined;
}

export interface SearchFilters {
  /** Case-insensitive substring match against Caption and Note. */
  query?: string;
  /** Context name, with or without the leading @. */
  context?: string;
  dueBefore?: string;
  dueAfter?: string;
  starred?: boolean;
  completed?: boolean;
  isProject?: boolean;
  flag?: string;
  /** 0–200 scale; a task without an explicit Importance counts as 100 (normal). */
  minImportance?: number;
}

export function searchTasks(tasks: TaskNode[], f: SearchFilters): TaskNode[] {
  const q = f.query?.toLowerCase();
  const ctx = f.context?.replace(/^@/, "").toLowerCase();
  return flatten(tasks).filter((t) => {
    if (q && !t.Caption.toLowerCase().includes(q) && !(t.Note ?? "").toLowerCase().includes(q)) return false;
    if (ctx && !t.Places.some((p) => p.replace(/^@/, "").toLowerCase() === ctx)) return false;
    if (f.dueBefore && !(t.DueDateTime && t.DueDateTime < f.dueBefore)) return false;
    if (f.dueAfter && !(t.DueDateTime && t.DueDateTime > f.dueAfter)) return false;
    if (f.starred !== undefined && (t.Starred ?? false) !== f.starred) return false;
    if (f.completed !== undefined && Boolean(t.CompletionDateTime) !== f.completed) return false;
    if (f.isProject !== undefined && (t.IsProject ?? false) !== f.isProject) return false;
    if (f.flag && t.Flag !== f.flag) return false;
    if (f.minImportance !== undefined && (t.Importance ?? 100) < f.minImportance) return false;
    return true;
  });
}

/** One-line human-readable summary of a task. */
export function renderLine(t: TaskNode): string {
  const marks: string[] = [];
  if (looksLikeInbox(t)) marks.push("[inbox]");
  // Named first among the states: everything else on the line is export truth,
  // and this one says the line is a write MLO has not applied yet.
  if (t.pending) marks.push("[pending]");
  if (t.CompletionDateTime) marks.push("[done]");
  if (t.IsProject) marks.push("[project]");
  if (t.Starred) marks.push("[*]");
  if (t.Flag) marks.push(`[flag:${t.Flag}]`);
  if (t.Importance !== undefined && t.Importance !== 100) marks.push(`[imp:${t.Importance}]`);
  if (t.DueDateTime) marks.push(`due:${t.DueDateTime}`);
  if (t.DependsOn.length) marks.push(`[waits-on:${t.DependsOn.length}]`);
  if (t.Places.length) marks.push(t.Places.join(","));
  return `[${t.id}] ${t.Caption}${marks.length ? " " + marks.join(" ") : ""}`;
}

export interface VisibleTask {
  task: TaskNode;
  depth: number;
}

/**
 * Depth-first list of what the outline shows: completed tasks prune their
 * whole subtree (unless includeCompleted) and maxDepth cuts descendants.
 * Single source of truth for list_tasks — its text outline and its
 * structuredContent must come from the same entries.
 */
export function collectVisible(
  tasks: TaskNode[],
  opts: { includeCompleted?: boolean; maxDepth?: number } = {}
): VisibleTask[] {
  const out: VisibleTask[] = [];
  const walk = (list: TaskNode[], depth: number) => {
    for (const t of list) {
      if (!opts.includeCompleted && t.CompletionDateTime) continue;
      if (opts.maxDepth !== undefined && depth >= opts.maxDepth) continue;
      out.push({ task: t, depth });
      walk(t.Children, depth + 1);
    }
  };
  walk(tasks, 0);
  return out;
}

export function renderVisible(entries: VisibleTask[], format: "tree" | "flat" = "tree"): string {
  if (!entries.length) return "(no tasks)";
  return entries
    .map((e) => (format === "flat" ? "" : "  ".repeat(e.depth)) + renderLine(e.task))
    .join("\n");
}

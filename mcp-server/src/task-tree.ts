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

/** The inbox as a RawTaskNode inside a parsed document (for mutation callbacks). */
export function findRawInbox(doc: MloDocument, configCaption?: string): RawTaskNode | undefined {
  const top = rootNode(doc).TaskNode ?? [];
  for (const cap of inboxCaptions(configCaption)) {
    const hit = top.find((n) => n["@_Caption"] === cap);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Locate the RawTaskNode for a path id inside the parsed document, together
 * with its parent's child array and index — what a mutation needs.
 */
export interface FoundRaw {
  raw: RawTaskNode;
  siblings: RawTaskNode[];
  index: number;
}

export function findRawById(doc: MloDocument, id: string): FoundRaw | undefined {
  const parts = id.split(".").map((p) => Number(p));
  if (parts.length === 0 || parts.some((p) => !Number.isInteger(p) || p < 1)) return undefined;
  let siblings = rootNode(doc).TaskNode ?? [];
  let raw: RawTaskNode | undefined;
  let index = -1;
  for (let i = 0; i < parts.length; i++) {
    index = parts[i] - 1;
    raw = siblings[index];
    if (!raw) return undefined;
    if (i < parts.length - 1) siblings = raw.TaskNode ?? [];
  }
  return raw ? { raw, siblings, index } : undefined;
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

import type { TaskNode } from "../types.js";
import { collectVisible, findById, flatten, searchTasks, type SearchFilters, type VisibleTask } from "../task-tree.js";
import type { MloRepository } from "../repo/mlo-repository.js";
import type { IdentityService } from "./identity.js";

export interface OutlineListing {
  entries: VisibleTask[];
  total: number;
}

export interface TaskDetail {
  task: TaskNode;
  /** The task's normalized GUID, when the binary annotation recovered one. */
  uid?: string;
  /** Resolved dependency targets; id/Caption absent when the uid matches no visible task. */
  dependsOn: { id?: string; Caption?: string; uid: string }[];
  dependedOnBy: { id: string; Caption: string }[];
}

export interface ContextUsage {
  Caption: string;
  /** Declared in the profile's places list (may carry open-hours schedules). */
  defined: boolean;
  tasksUsing: number;
}

interface RawTaskPlace {
  "@_Caption": string;
  [key: string]: unknown;
}

/**
 * The outline aggregate's service (spec section 3). Its charter is every
 * mutation of the outline — the write verbs arrive with the resident write
 * path (tickets 06-07). Until the read services stand up (ticket 08), the raw
 * outline browsing reads live here too: they are views of the aggregate
 * itself, not GTD-intent queries.
 */
export class OutlineService {
  constructor(
    private readonly repo: MloRepository,
    private readonly identity: IdentityService
  ) {}

  /** Visible outline entries under `parentId` (or the root); undefined when the parent id resolves to nothing. */
  async list(opts: {
    parentId?: string;
    includeCompleted?: boolean;
    maxDepth?: number;
  }): Promise<OutlineListing | undefined> {
    const snap = await this.repo.snapshot();
    let tasks = snap.tasks;
    if (opts.parentId) {
      const parent = findById(snap.tasks, opts.parentId);
      if (!parent) return undefined;
      tasks = parent.Children;
    }
    const entries = collectVisible(tasks, { includeCompleted: opts.includeCompleted, maxDepth: opts.maxDepth });
    return { entries, total: entries.length };
  }

  async search(filters: SearchFilters): Promise<TaskNode[]> {
    const snap = await this.repo.snapshot();
    return searchTasks(snap.tasks, filters);
  }

  /** Full detail of one task by path id; undefined when the id resolves to nothing. */
  async get(id: string): Promise<TaskDetail | undefined> {
    const snap = await this.repo.snapshot();
    const task = findById(snap.tasks, id);
    if (!task) return undefined;
    const resolver = this.identity.resolverFor(snap);
    const resolution = resolver.uidFor(id);
    const resolvedUid = resolution.kind === "resolved" ? resolution.uid : undefined;
    const dependsOn = task.DependsOn.map((uid) => {
      const dep = resolver.taskFor(uid);
      return { id: dep?.id, Caption: dep?.Caption, uid };
    });
    const dependedOnBy = resolvedUid
      ? resolver.dependentsOf(resolvedUid).map((x) => ({ id: x.id, Caption: x.Caption }))
      : [];
    return { task, uid: resolvedUid, dependsOn, dependedOnBy };
  }

  /** The profile's contexts: defined Places plus any referenced by tasks, with usage counts. */
  async contexts(): Promise<ContextUsage[]> {
    const snap = await this.repo.snapshot();
    const placesList = snap.doc["MyLifeOrganized-xml"].PlacesList as { TaskPlace?: RawTaskPlace[] } | undefined;
    const defined = (placesList?.TaskPlace ?? []).map((p) => p["@_Caption"]);

    const usage = new Map<string, number>();
    for (const t of flatten(snap.tasks)) {
      for (const p of t.Places) usage.set(p, (usage.get(p) ?? 0) + 1);
    }

    const captions = [...new Set([...defined, ...usage.keys()])];
    return captions
      .map((Caption) => ({ Caption, defined: defined.includes(Caption), tasksUsing: usage.get(Caption) ?? 0 }))
      .sort((a, b) => b.tasksUsing - a.tasksUsing || a.Caption.localeCompare(b.Caption));
  }
}

import type { TaskNode } from "../types.js";
import {
  collectVisible,
  findById,
  findInbox,
  flatten,
  searchTasks,
  type SearchFilters,
  type VisibleTask,
} from "../task-tree.js";
import {
  repoFailure,
  type DeltaRow,
  type MloRepository,
  type Snapshot,
  type WriteId,
  type WriteStatus,
} from "../repo/mlo-repository.js";
import type { IdentityService, SnapshotResolver } from "./identity.js";
import type { CapturedRow, RowCatalog, RowStore } from "../cloud/row-store.js";
import type { SectionedCsv } from "../cloud/csv.js";
import { readPlaces } from "../places.js";
import { mergeDeltas } from "../cloud/delta-merge.js";
import { generateGuid, normalizeGuid } from "../cloud/guid.js";
import {
  buildTaskAddDelta,
  buildTaskDeleteDelta,
  buildTaskUpdatesDelta,
  deltaRowsFromDocument,
} from "../cloud/mlo-schema.js";
import {
  completionPatch,
  csvTruthy,
  ITEM_INDEX_STEP,
  itemIndexAt,
  nowIso,
  parseCaptureLine,
  reopenPatch,
  rowValue,
  updatePatch,
  type MoveDestination,
  type TaskPatch,
} from "./outline-authoring.js";
import { failed, ok, type Failure, type ServiceResult } from "../result.js";
import { failureFor } from "../error-contract.js";
import { unresolvable, type OutlineFailure, type ReadFailure } from "./failures.js";

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

/**
 * The row store as OutlineService uses it: the authoring source for
 * update/complete (the target's latest full 82-column row plus its relation
 * sets) and the catalog captions resolve against. Narrowed to the two reads so
 * the service cannot ingest or replace anything.
 */
export type AuthoringRows = Pick<RowStore, "latest" | "catalog">;

/** What the caller gets at durable accept — never a delivery promise. */
export interface WriteReceipt {
  /** The UIDs this write addresses, in authoring order. */
  uids: string[];
  writeId: WriteId;
  expiresAt: string;
}

export type OutlineWrite = ServiceResult<WriteReceipt, OutlineFailure>;

/**
 * Where one accept receipt stands (spec section 2). Five states, and for each
 * one a sentence saying what it means for the caller plus, where anything can
 * be done about it, the thing to do. The states themselves come from the write
 * path; the words are this service's, because "what does superseded mean for
 * me" is a domain question, not an infra one.
 */
export interface WriteProgress {
  writeId: WriteId;
  status: WriteStatus;
  /** The task the write addressed, when the write path recorded one. */
  uid?: string;
  /** Present while still queued: when an undelivered write gives up. */
  expiresAt?: string;
  /** When the write resolved, for every state past `accepted`. */
  at?: string;
  detail: string;
  remedy?: string;
}

/** One sentence per state, plus what ends it where anything can. */
const PROGRESS_WORDS: Record<WriteStatus, { detail: string; remedy?: string }> = {
  accepted: {
    detail: "durably queued — it lands the next time MLO syncs through the endpoint",
    remedy: "nothing to do; MLO syncs on its own within about 90 seconds, or run `sync` to hurry it",
  },
  delivered: { detail: "MLO applied this write to the profile" },
  verified: { detail: "MLO applied this write and a fresh export confirmed it" },
  expired: {
    detail: "MLO did not sync before the write's TTL ran out, so it was never applied — the rows are in the dead-letter file",
    remedy: "check MLO is running and syncing through the endpoint (`cloud_status`), then make the change again",
  },
  superseded: {
    detail:
      "MLO applied a different version of this task instead — a conflict the app resolved in favour of its own copy, " +
      "so this write's content is gone",
    remedy: "read the task again and re-apply the change on top of what MLO kept",
  },
};

/**
 * One task to create; `key` links it to others in the same batch.
 *
 * Casing follows the source of each field: names that are TodoItems COLUMNS
 * keep the column's own capitalization (`IsProject`, `Places`, `Flag`), and
 * everything the caller phrases itself stays lowerCamel.
 */
export interface TaskSpec {
  key?: string;
  caption: string;
  note?: string;
  dueDateTime?: string;
  startDateTime?: string;
  /** Local key of another task in the same batch. */
  parentKey?: string;
  /** Path id of an existing task; mutually exclusive with parentKey. */
  parentId?: string;
  IsProject?: boolean;
  Starred?: boolean;
  Folder?: boolean;
  HideInToDo?: boolean;
  CompleteSubTasksInOrder?: boolean;
  Flag?: string;
  Places?: string[];
  dependsOnKeys?: string[];
  dependsOnIds?: string[];
}

function refusal(
  kind: "unsupported-edit" | "invalid-request",
  detail: string,
  remedy: string,
): Failure & { kind: "unsupported-edit" | "invalid-request" } {
  return failureFor(kind, detail, remedy);
}

/** The refusal a write meets when this session's profile has no bound partition. */
const UNBOUND: OutlineFailure = failureFor(
  "partition-not-ready",
  "this profile has no bound cloud partition, so there is nowhere to author against",
);

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
    private readonly identity: IdentityService,
    /** Absent while the profile is unbound: every write then refuses `partition-not-ready`. */
    private readonly rows?: AuthoringRows,
    private readonly options: { inboxCaption?: string } = {}
  ) {}

  /** Visible outline entries under `parentId` (or the root). */
  async list(opts: {
    parentId?: string;
    includeCompleted?: boolean;
    maxDepth?: number;
  }): Promise<ServiceResult<OutlineListing, ReadFailure>> {
    const read = await this.repo.snapshot();
    if (read.isErrored) return failed(read.failure);
    const snap = read.value;
    let tasks = snap.tasks;
    if (opts.parentId) {
      const parent = findById(snap.tasks, opts.parentId);
      if (!parent) return failed(unresolvable(opts.parentId, `no task with id "${opts.parentId}" in this snapshot`));
      tasks = parent.Children;
    }
    const entries = collectVisible(tasks, { includeCompleted: opts.includeCompleted, maxDepth: opts.maxDepth });
    return ok({ entries, total: entries.length });
  }

  async search(filters: SearchFilters): Promise<ServiceResult<TaskNode[], ReadFailure>> {
    const read = await this.repo.snapshot();
    if (read.isErrored) return failed(read.failure);
    return ok(searchTasks(read.value.tasks, filters));
  }

  /** Full detail of one task by path id. */
  async get(id: string): Promise<ServiceResult<TaskDetail, ReadFailure>> {
    const read = await this.repo.snapshot();
    if (read.isErrored) return failed(read.failure);
    const snap = read.value;
    const task = findById(snap.tasks, id);
    if (!task) return failed(unresolvable(id, `no task with id "${id}" in this snapshot`));
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
    return ok({ task, uid: resolvedUid, dependsOn, dependedOnBy });
  }

  /** The profile's contexts: defined Places plus any referenced by tasks, with usage counts. */
  async contexts(): Promise<ServiceResult<ContextUsage[], ReadFailure>> {
    const read = await this.repo.snapshot();
    if (read.isErrored) return failed(read.failure);
    const snap = read.value;
    const defined = readPlaces(snap.doc).map((p) => p.Caption);

    const usage = new Map<string, number>();
    for (const t of flatten(snap.tasks)) {
      for (const p of t.Places) usage.set(p, (usage.get(p) ?? 0) + 1);
    }

    const captions = [...new Set([...defined, ...usage.keys()])];
    return ok(
      captions
        .map((Caption) => ({ Caption, defined: defined.includes(Caption), tasksUsing: usage.get(Caption) ?? 0 }))
        .sort((a, b) => b.tasksUsing - a.tasksUsing || a.Caption.localeCompare(b.Caption)),
    );
  }

  // ---------------------------------------------------------------- writes

  /** Create one task. */
  add(spec: TaskSpec): Promise<OutlineWrite> {
    return this.addMany([spec]);
  }

  /**
   * Create a whole outline as one write: `key`/`parentKey` express arbitrary
   * parent/child nesting and within-batch dependencies, `parentId` links to a
   * task that already exists. Input order is sibling order.
   */
  async addMany(specs: readonly TaskSpec[]): Promise<OutlineWrite> {
    const opened = await this.authoring();
    if (opened.isErrored) return opened;
    return this.addInto(opened.value, specs);
  }

  /** The add pipeline over an already-opened authoring context (capture shares it). */
  private async addInto(opened: Authoring, specs: readonly TaskSpec[]): Promise<OutlineWrite> {
    if (!specs.length) {
      return failed(refusal("invalid-request", "no tasks to add", "pass at least one task"));
    }
    const { snapshot, resolver, catalog, rows } = opened;

    const keyed = specs.map((spec, index) => ({ key: spec.key ?? `#${index + 1}`, spec }));
    const byKey = new Map<string, TaskSpec>();
    for (const { key, spec } of keyed) {
      if (byKey.has(key)) {
        return failed(refusal("invalid-request", `duplicate task key "${key}"`, "give each task a unique key"));
      }
      byKey.set(key, spec);
    }
    const graph = validateAddGraph(keyed, byKey);
    if (graph) return failed(graph);

    const uids = new Map(keyed.map(({ key }) => [key, generateGuid()]));
    // Existing parents keep their sibling spacing; batch-created ones start fresh.
    const nextIndex = new Map<string, number>();
    let starredOrder = catalog.maxStarredOrderIndex;
    const documents: SectionedCsv[] = [];
    for (const { key, spec } of keyed) {
      let parentUid: string | undefined;
      if (spec.parentKey !== undefined) parentUid = uids.get(spec.parentKey)!;
      else if (spec.parentId !== undefined) {
        const resolved = this.resolveTarget(resolver, spec.parentId);
        if (resolved.isErrored) return resolved;
        parentUid = resolved.value;
      }
      const parentKey = parentUid?.toUpperCase() ?? "";
      if (!nextIndex.has(parentKey)) {
        const siblings =
          spec.parentKey !== undefined ? [] : await this.siblingIndices(opened, parentUid);
        nextIndex.set(parentKey, itemIndexAt(siblings));
      }
      const itemIndex = nextIndex.get(parentKey)!;
      nextIndex.set(parentKey, itemIndex + ITEM_INDEX_STEP);

      const places = this.resolvePlaces(spec.Places, catalog);
      if (places.isErrored) return places;
      const flag = this.resolveFlag(spec.Flag, catalog);
      if (flag.isErrored) return flag;
      const dependencies: string[] = [];
      for (const id of spec.dependsOnIds ?? []) {
        const resolved = this.resolveTarget(resolver, id);
        if (resolved.isErrored) return resolved;
        dependencies.push(resolved.value);
      }
      for (const dependencyKey of spec.dependsOnKeys ?? []) dependencies.push(uids.get(dependencyKey)!);
      if (new Set(dependencies.map((uid) => uid.toUpperCase())).size !== dependencies.length) {
        return failed(
          refusal("invalid-request", `task "${key}" has duplicate dependency targets`, "name each dependency once"),
        );
      }
      if (spec.Starred) starredOrder += STARRED_ORDER_STEP;

      documents.push(
        buildTaskAddDelta({
          uid: uids.get(key)!,
          ...(parentUid !== undefined ? { parentUid } : {}),
          itemIndex: String(itemIndex),
          caption: spec.caption,
          createdDate: this.now(),
          lastModified: this.now(),
          ...(spec.note !== undefined ? { note: spec.note } : {}),
          ...(spec.dueDateTime !== undefined ? { dueDateTime: spec.dueDateTime } : {}),
          ...(spec.startDateTime !== undefined ? { startDateTime: spec.startDateTime } : {}),
          ...(spec.IsProject !== undefined ? { isProject: spec.IsProject } : {}),
          ...(spec.Starred !== undefined ? { starred: spec.Starred } : {}),
          ...(spec.Folder !== undefined ? { hideInToDoThisTask: spec.Folder } : {}),
          ...(spec.HideInToDo !== undefined ? { hideInToDo: spec.HideInToDo } : {}),
          ...(spec.CompleteSubTasksInOrder !== undefined ? { completeInOrder: spec.CompleteSubTasksInOrder } : {}),
          ...(flag.value !== undefined ? { flagUid: flag.value } : {}),
          ...(spec.Places !== undefined ? { placeUids: places.value } : {}),
          ...(dependencies.length ? { dependencyUids: dependencies } : {}),
          ...(spec.Starred ? { starredOrderIndex: String(starredOrder) } : {}),
        }),
      );
    }
    return this.commit(
      deltaRowsFromDocument(mergeDeltas(documents)),
      keyed.map(({ key }) => uids.get(key)!),
    );
  }

  /**
   * Rapid entry: one line in, one task in the inbox out. Inbox defaulting is
   * the write policy that makes capture usable — a captured thought with no
   * home belongs in MLO's own `<Inbox>` node, and falls back to the top level
   * only when the profile has none.
   */
  async capture(line: string): Promise<OutlineWrite> {
    const parsed = parseCaptureLine(line);
    if (!parsed.caption) {
      return failed(refusal("invalid-request", "nothing to capture: the line has no caption", "pass some text"));
    }
    const opened = await this.authoring();
    if (opened.isErrored) return opened;
    const inbox = findInbox(opened.value.snapshot.tasks, this.options.inboxCaption);
    return this.addInto(opened.value, [
      {
        caption: parsed.caption,
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        ...(parsed.places.length ? { Places: parsed.places } : {}),
        ...(inbox ? { parentId: inbox.id } : {}),
      },
    ]);
  }

  /** Change fields of one existing task. Only provided fields change. */
  async update(id: string, patch: TaskPatch): Promise<OutlineWrite> {
    if (!Object.values(patch).some((value) => value !== undefined)) {
      return failed(refusal("invalid-request", `nothing to update on "${id}"`, "pass at least one field"));
    }
    return this.rewrite(id, (target) => {
      const editsDates =
        patch.DueDateTime !== undefined || patch.StartDateTime !== undefined || patch.CompletionDateTime !== undefined;
      if (editsDates && csvTruthy(rowValue(target.row, "RecType"))) {
        return failed(recurrenceRefusal(target.caption, "date edits"));
      }
      const places = this.resolvePlaces(patch.Places, target.catalog);
      if (places.isErrored) return places;
      const flag = this.resolveFlag(patch.Flag, target.catalog);
      if (flag.isErrored) return flag;
      const dependencies: string[] = [];
      for (const dependencyId of patch.dependsOnIds ?? []) {
        const resolved = this.resolveTarget(target.resolver, dependencyId);
        if (resolved.isErrored) return resolved;
        if (resolved.value.toUpperCase() === target.uid.toUpperCase()) {
          return failed(
            refusal("invalid-request", `"${target.caption}" cannot depend on itself`, "drop it from dependsOnIds"),
          );
        }
        dependencies.push(resolved.value);
      }
      return ok({
        columns: updatePatch(patch, target.row, this.now(), undefined, flag.value),
        ...(patch.Places !== undefined ? { placeUids: places.value } : {}),
        ...(patch.dependsOnIds !== undefined ? { dependencyUids: dependencies } : {}),
        ...(patch.Starred !== undefined ? { starred: patch.Starred } : {}),
      });
    });
  }

  /**
   * Mark a task completed. Recurring tasks refuse: completing one in MLO
   * spawns the next occurrence, and a full-row rewrite through the sync loop
   * would not — it would silently end the series.
   */
  complete(id: string): Promise<OutlineWrite> {
    return this.rewrite(id, (target) =>
      csvTruthy(rowValue(target.row, "RecType"))
        ? failed(recurrenceRefusal(target.caption, "completion"))
        : ok({ columns: completionPatch(target.row, this.now()) }),
    );
  }

  /**
   * Reopen a completed task. Unlike `complete`, recurring tasks are allowed:
   * reopening generates no occurrence, so there is no MLO-side behaviour for a
   * full-row rewrite to bypass.
   */
  uncomplete(id: string): Promise<OutlineWrite> {
    return this.rewrite(id, (target) => ok({ columns: reopenPatch(target.row, this.now()) }));
  }

  /** Move a task (with its subtree) under another parent, optionally into a slot. */
  move(id: string, newParentId?: string, position?: number): Promise<OutlineWrite> {
    return this.rewrite(id, async (target) => {
      let parentUid = "";
      if (newParentId !== undefined && newParentId !== "") {
        const destination = findById(target.opened.snapshot.tasks, newParentId);
        const task = target.resolver.taskFor(target.uid);
        if (destination && task && flatten([task]).includes(destination)) {
          return failed(
            refusal(
              "invalid-request",
              `cannot move "${target.caption}" into its own subtree`,
              "pick a destination outside the moved branch",
            ),
          );
        }
        const resolved = this.resolveTarget(target.resolver, newParentId);
        if (resolved.isErrored) return resolved;
        parentUid = resolved.value;
      }
      const siblings = await this.siblingIndices(target.opened, parentUid || undefined, target.uid);
      const move: MoveDestination = { parentUid, itemIndex: String(itemIndexAt(siblings, position)) };
      return ok({ columns: updatePatch({}, target.row, this.now(), move) });
    });
  }

  /** Tombstone a task and every descendant — a partial subtree would orphan children. */
  async delete(id: string): Promise<OutlineWrite> {
    const opened = await this.authoring();
    if (opened.isErrored) return opened;
    const { snapshot } = opened.value;
    const task = findById(snapshot.tasks, id);
    if (!task) return failed(unresolvable(id, `no task with id "${id}" in this snapshot`));
    const uids: string[] = [];
    for (const node of flatten([task])) {
      if (!node.Guid) {
        return failed(
          unresolvable(node.id, `no recoverable GUID for "${node.Caption}" in the branch under "${task.Caption}"`),
        );
      }
      uids.push(normalizeGuid(node.Guid));
    }
    return this.commit(deltaRowsFromDocument(buildTaskDeleteDelta(uids)), uids);
  }

  /**
   * Where an accept receipt stands. The one read on this service that is about
   * a write rather than the outline: a receipt outlives the call that returned
   * it, and the caller that holds one has nowhere else to ask.
   */
  async writeStatus(writeId: WriteId): Promise<ServiceResult<WriteProgress, OutlineFailure>> {
    const state = await this.repo.status(writeId);
    if (state.isErrored) return failed(state.failure);
    const { detail, remedy } = PROGRESS_WORDS[state.value.status];
    return ok({
      writeId: state.value.writeId,
      status: state.value.status,
      ...(state.value.uid ? { uid: state.value.uid } : {}),
      ...(state.value.expiresAt ? { expiresAt: state.value.expiresAt } : {}),
      ...(state.value.at ? { at: state.value.at } : {}),
      // The write path's own words come first when it has any: they name the
      // task and the session, which no generic sentence can.
      detail: state.value.detail ? `${state.value.detail} — ${detail}` : detail,
      ...(remedy ? { remedy } : {}),
    });
  }

  // -------------------------------------------------------- Organize verbs

  /** Promote a task to a project (Organize). */
  makeProject(id: string, isProject = true): Promise<OutlineWrite> {
    return this.update(id, { IsProject: isProject });
  }

  /** Replace the complete set of tasks this one waits for (Organize). */
  setDependencies(id: string, dependsOnIds: string[]): Promise<OutlineWrite> {
    return this.update(id, { dependsOnIds });
  }

  /** Sequential vs parallel subtasks (Organize). */
  setSequential(id: string, sequential: boolean): Promise<OutlineWrite> {
    return this.update(id, { CompleteSubTasksInOrder: sequential });
  }

  // -------------------------------------------------------------- internals

  /** Overridable clock seam; MLO stores naive local timestamps. */
  protected now(): string {
    return nowIso();
  }

  /**
   * The shared opening move of every write: a fresh snapshot (ids come from a
   * read the caller already did, and a stale tree resolves them to the wrong
   * rows), its resolver, and the row store this profile authors against.
   */
  private async authoring(): Promise<ServiceResult<Authoring, OutlineFailure>> {
    if (!this.rows) return failed(UNBOUND);
    const read = await this.repo.snapshot(true);
    if (read.isErrored) return failed(read.failure);
    const snapshot = read.value;
    return ok({
      snapshot,
      resolver: this.identity.resolverFor(snapshot),
      rows: this.rows,
      catalog: await this.rows.catalog(),
    });
  }

  /**
   * Author one full-row rewrite from the row store's latest captured row. The
   * row IS the authoring source: a TodoItems row merges as a full-record
   * replacement, so anything it omits is blanked in the profile — which is why
   * a row-store miss refuses with `repull` instead of authoring from the
   * export.
   */
  private async rewrite(
    id: string,
    plan: (target: RewriteTarget) => RewritePlan | Promise<RewritePlan>,
  ): Promise<OutlineWrite> {
    const opened = await this.authoring();
    if (opened.isErrored) return opened;
    const { resolver, rows, catalog } = opened.value;
    const resolvedUid = this.resolveTarget(resolver, id);
    if (resolvedUid.isErrored) return resolvedUid;
    const uid = resolvedUid.value;
    const lookup = await rows.latest(uid);
    if (lookup.kind !== "row") {
      return failed({
        kind: "unknown-row",
        uid: lookup.uid,
        retryable: lookup.retryable,
        remedy: lookup.remedy,
        detail: lookup.detail,
      });
    }
    const caption = resolver.taskFor(uid)?.Caption ?? rowValue(lookup, "Caption");
    const planned = await plan({ opened: opened.value, resolver, catalog, uid, caption, row: lookup });
    if (planned.isErrored) return planned;
    const { columns, placeUids, dependencyUids, starred } = planned.value;
    const starredOrderIndex = starredOrderFor(lookup, catalog, starred);
    const document = buildTaskUpdatesDelta([
      {
        header: lookup.header,
        row: lookup.cells,
        patch: columns,
        // Relations travel on every rewrite, defaulting to what the captured
        // row carries: omitting them would clear the task's contexts.
        placeUids: placeUids ?? lookup.placeUids,
        dependencyUids: dependencyUids ?? lookup.dependencyUids,
        ...(starredOrderIndex !== undefined ? { starredOrderIndex } : {}),
      },
    ]);
    return this.commit(deltaRowsFromDocument(document), [uid]);
  }

  private resolveTarget(resolver: SnapshotResolver, id: string): ServiceResult<string, OutlineFailure> {
    const resolution = resolver.uidFor(id);
    return resolution.kind === "resolved" ? ok(resolution.uid) : failed(unresolvable(id, resolution.detail));
  }

  private resolvePlaces(
    captions: readonly string[] | undefined,
    catalog: RowCatalog,
  ): ServiceResult<string[], OutlineFailure> {
    if (captions === undefined) return ok([]);
    const seen = new Set<string>();
    const uids: string[] = [];
    for (const caption of captions) {
      const key = caption.toLocaleLowerCase();
      if (seen.has(key)) {
        return failed(refusal("invalid-request", `duplicate context "${caption}"`, "name each context once"));
      }
      seen.add(key);
      const match = catalog.places.find((place) => place.caption.toLocaleLowerCase() === key);
      if (!match) {
        return failed(
          refusal(
            "invalid-request",
            `no context named "${caption}" in this profile`,
            "create the context in MLO first, or run list_contexts to see the existing ones",
          ),
        );
      }
      uids.push(match.uid);
    }
    return ok(uids);
  }

  /** `undefined` = untouched, `""` = cleared, otherwise the flag's UID. */
  private resolveFlag(
    caption: string | undefined,
    catalog: RowCatalog,
  ): ServiceResult<string | undefined, OutlineFailure> {
    if (caption === undefined) return ok(undefined);
    if (caption === "") return ok("");
    const match = catalog.flags.find((flag) => flag.caption.toLocaleLowerCase() === caption.toLocaleLowerCase());
    return match
      ? ok(match.uid)
      : failed(refusal("invalid-request", `no flag named "${caption}" in this profile`, "create the flag in MLO first"));
  }

  /** Current ItemIndex values of a parent's children, from their captured rows. */
  private async siblingIndices(
    { snapshot, resolver, rows }: Authoring,
    parentUid?: string,
    excludeUid?: string,
  ): Promise<number[]> {
    const parent = parentUid ? resolver.taskFor(parentUid) : undefined;
    if (parentUid && !parent) return [];
    const siblings = parent ? parent.Children : snapshot.tasks;
    const indices: number[] = [];
    let unknown = 0;
    for (const sibling of siblings) {
      const lookup = sibling.Guid ? await rows.latest(sibling.Guid) : undefined;
      if (lookup?.kind !== "row") {
        unknown += 1;
        continue;
      }
      if (excludeUid && sibling.Guid!.toUpperCase() === excludeUid.toUpperCase()) continue;
      const index = Number(rowValue(lookup, "ItemIndex"));
      if (Number.isFinite(index)) indices.push(index);
      else unknown += 1;
    }
    // Siblings whose row the store has not seen still occupy slots. Their
    // indices are unknown, but MLO spaces siblings by ITEM_INDEX_STEP, so one
    // step per unseen sibling keeps an append past the visible ones instead of
    // colliding with them. A gap is not worth refusing an add over — unlike a
    // rewrite, an add invents its own row.
    if (unknown) indices.push((indices.length ? Math.max(...indices) : 0) + unknown * ITEM_INDEX_STEP);
    return indices;
  }

  /** The one place a service touches the repository seam. */
  private async commit(rows: DeltaRow[], uids: string[]): Promise<OutlineWrite> {
    const written = await this.repo.write(rows);
    if (written.isErrored) return failed(written.failure);
    return ok({ uids, writeId: written.value.writeId, expiresAt: written.value.expiresAt });
  }
}

/** MLO spaces manual starred ordering the way it spaces siblings. */
const STARRED_ORDER_STEP = 500;

/** Everything a write needs to be authored, opened once per call. */
interface Authoring {
  snapshot: Snapshot;
  resolver: SnapshotResolver;
  rows: AuthoringRows;
  catalog: RowCatalog;
}

interface RewriteTarget {
  opened: Authoring;
  resolver: SnapshotResolver;
  catalog: RowCatalog;
  uid: string;
  caption: string;
  row: CapturedRow;
}

type RewritePlan = ServiceResult<
  {
    columns: Record<string, string>;
    placeUids?: string[];
    dependencyUids?: string[];
    /** Set only when the write itself changes the starred flag. */
    starred?: boolean;
  },
  OutlineFailure
>;

/**
 * A newly starred task needs a manual-order row; one that keeps its star keeps
 * its place in that order; unstarring drops out of it (mergeDeltas prunes the
 * ordering row when Starred is 0).
 */
function starredOrderFor(row: CapturedRow, catalog: RowCatalog, starred?: boolean): string | undefined {
  const isStarred = starred ?? csvTruthy(rowValue(row, "Starred"));
  if (!isStarred) return undefined;
  return row.starredOrderIndex ?? String(catalog.maxStarredOrderIndex + STARRED_ORDER_STEP);
}

function recurrenceRefusal(caption: string, what: string): OutlineFailure {
  return failureFor(
    "unsupported-edit",
    `"${caption}" is recurring — ${what} through the sync path would bypass MLO's recurrence generation ` +
      "and silently end the series",
    "do this in the MLO app, so it generates the next occurrence",
  );
}

/** Batch-shape rules that hold before anything is resolved or authored. */
function validateAddGraph(
  keyed: ReadonlyArray<{ key: string; spec: TaskSpec }>,
  byKey: ReadonlyMap<string, TaskSpec>,
): OutlineFailure | undefined {
  const bad = (detail: string, remedy: string) => refusal("invalid-request", detail, remedy);
  for (const { key, spec } of keyed) {
    if (spec.parentKey !== undefined && spec.parentId !== undefined) {
      return bad(`task "${key}" has both parentKey and parentId`, "pick one parent");
    }
    if (spec.parentKey !== undefined && !byKey.has(spec.parentKey)) {
      return bad(`task "${key}" references unknown parentKey "${spec.parentKey}"`, "name a key present in this batch");
    }
    const keys = spec.dependsOnKeys ?? [];
    if (new Set(keys).size !== keys.length) return bad(`task "${key}" has duplicate dependsOnKeys`, "name each once");
    for (const dependencyKey of keys) {
      if (!byKey.has(dependencyKey)) {
        return bad(
          `task "${key}" references unknown dependsOnKey "${dependencyKey}"`,
          "name a key present in this batch",
        );
      }
      if (dependencyKey === key) return bad(`task "${key}" cannot depend on itself`, "drop it from dependsOnKeys");
    }
  }
  for (const { key, spec } of keyed) {
    const seen = new Set<string>([key]);
    let parentKey = spec.parentKey;
    while (parentKey !== undefined) {
      if (seen.has(parentKey)) return bad(`parentKey cycle involving "${key}" and "${parentKey}"`, "break the cycle");
      seen.add(parentKey);
      parentKey = byKey.get(parentKey)!.parentKey;
    }
  }
  return undefined;
}

import type { TaskNode } from "../types.js";
import type { Snapshot } from "../repo/mlo-repository.js";
import type { RowStoreView } from "../cloud/row-store.js";
import { alignExportToRows, type AlignedIdentity } from "./structure-align.js";
import { findById, flatten } from "../task-tree.js";
import { normalizeGuid } from "../cloud/guid.js";
import { log } from "../log.js";

/**
 * A write target in brace form is a GUID, never a path id — the two shapes
 * cannot collide (path ids are digits and dots), so no parameter is needed to
 * pick the interpretation.
 */
export function isGuidTarget(target: string): boolean {
  return target.startsWith("{");
}

export type UidResolution =
  | {
      kind: "resolved";
      uid: string;
      /**
       * confirmed: the row store holds this UID, so update/complete can author
       * from its latest full row — structural resolutions are confirmed by
       * construction (the UID came from the store). unconfirmed: recovered
       * from the binary but absent from the row store — a write against it
       * will refuse with the `repull` remedy (ticket 07).
       */
      confidence: "confirmed" | "unconfirmed";
    }
  | { kind: "unresolvable"; reason: "unknown-id" | "no-recoverable-guid"; detail: string };

/**
 * Stamp the identity ladder's answer onto a raw export: structural alignment
 * against the row store first, the binary-recovered annotation as fallback,
 * written into each task's `Guid`. Run where the snapshot is built, BEFORE the
 * pending overlay composes — so the overlay's row-to-task pairing, the read
 * tools' `Guid` fields, and the write resolver all answer identity from the
 * same authority instead of each picking their own source.
 */
export function stampIdentity(tasks: TaskNode[], rows: RowStoreView): void {
  const aligned = alignExportToRows(tasks, rows.alignmentRows());
  for (const task of flatten(tasks)) {
    const structural = aligned.byPathId.get(task.id);
    if (!structural) continue;
    const binary = task.Guid?.toUpperCase();
    if (binary && binary !== structural.toUpperCase()) {
      log(
        `GUID cross-check mismatch for [${task.id}] "${task.Caption}": ` +
          `binary ${binary} vs structural ${structural} — stamping structural`,
      );
    }
    task.Guid = structural;
  }
}

/**
 * One owner for "which row is this id" (spec section 3): a resolver built once
 * per snapshot, aligning the export against the row store — structural
 * alignment (UID/ParentUID/ItemIndex vs the export tree) is the identity
 * authority, and the binary-recovered GUID annotation (guids.ts, run where the
 * snapshot is built) is the cross-check and the fallback for nodes alignment
 * could not place. A contradiction logs and structural wins: chain recovery
 * misaligns exactly when the tree drifts, and its footer marker is known to
 * misread on some files.
 *
 * OutlineService (writes) depends on this; read services never do.
 */
export class IdentityService {
  private readonly resolvers = new WeakMap<Snapshot, SnapshotResolver>();

  constructor(private readonly rows: RowStoreView) {}

  /** The single resolver construction site: one resolver per snapshot, cached by identity. */
  resolverFor(snapshot: Snapshot): SnapshotResolver {
    let resolver = this.resolvers.get(snapshot);
    if (!resolver) {
      resolver = new SnapshotResolver(snapshot.tasks, this.rows);
      this.resolvers.set(snapshot, resolver);
    }
    return resolver;
  }
}

export class SnapshotResolver {
  private readonly byUid = new Map<string, TaskNode>();
  private readonly aligned: AlignedIdentity;
  private readonly all: TaskNode[];

  constructor(
    private readonly tasks: TaskNode[],
    private readonly rows: RowStoreView
  ) {
    this.all = flatten(tasks);
    this.aligned = alignExportToRows(tasks, rows.alignmentRows());
    // uid -> task mirrors the ladder: structural claims first, annotations
    // fill only the UIDs alignment left unclaimed.
    for (const task of this.all) {
      const structural = this.aligned.byPathId.get(task.id);
      if (structural) this.byUid.set(structural.toUpperCase(), task);
    }
    for (const task of this.all) {
      const binary = task.Guid?.toUpperCase();
      if (binary && !this.byUid.has(binary)) this.byUid.set(binary, task);
    }
  }

  /**
   * Resolve a write target — a path id, or a stable GUID in brace form — to
   * the row UID a write would address. A typed refusal, never a guess; a
   * brace-form target is never reinterpreted as a path id.
   */
  uidFor(target: string): UidResolution {
    if (isGuidTarget(target)) return this.uidForGuid(target);
    return this.uidForPath(target);
  }

  /**
   * A GUID names its task directly, however the tree has shifted since the
   * caller read it. Known means the snapshot carries it (annotation or
   * alignment) or the row store does; anything else refuses rather than
   * accepting a write against a task nobody can name.
   */
  private uidForGuid(target: string): UidResolution {
    let uid: string;
    try {
      uid = normalizeGuid(target);
    } catch {
      return {
        kind: "unresolvable",
        reason: "unknown-id",
        detail: `"${target}" is neither a valid GUID ("{XXXXXXXX-...}") nor a path id`,
      };
    }
    const inSnapshot = this.byUid.has(uid.toUpperCase());
    const inStore = this.rows.captionOf(uid) !== undefined;
    if (!inSnapshot && !inStore) {
      return {
        kind: "unresolvable",
        reason: "unknown-id",
        detail: `no task with GUID ${uid} in this profile — GUIDs are never read as path ids`,
      };
    }
    return { kind: "resolved", uid, confidence: inStore ? "confirmed" : "unconfirmed" };
  }

  private uidForPath(pathId: string): UidResolution {
    const task = findById(this.tasks, pathId);
    if (!task) {
      return { kind: "unresolvable", reason: "unknown-id", detail: `no task with id "${pathId}" in this snapshot` };
    }
    const structural = this.aligned.byPathId.get(task.id);
    const binary = task.Guid?.toUpperCase();
    if (structural) {
      if (binary && binary !== structural.toUpperCase()) {
        log(
          `GUID cross-check mismatch for [${task.id}] "${task.Caption}": ` +
            `binary ${binary} vs structural ${structural} — using structural`,
        );
      }
      return { kind: "resolved", uid: structural, confidence: "confirmed" };
    }
    if (binary) {
      const confidence = this.rows.captionOf(binary) !== undefined ? "confirmed" : "unconfirmed";
      return { kind: "resolved", uid: binary, confidence };
    }
    return {
      kind: "unresolvable",
      reason: "no-recoverable-guid",
      detail:
        `"${task.Caption}" aligns to no captured row and has no recoverable GUID — ` +
        `sync so the endpoint captures it, then retry`,
    };
  }

  taskFor(uid: string): TaskNode | undefined {
    return this.byUid.get(uid.toUpperCase());
  }

  /** Tasks whose DependsOn names this UID. */
  dependentsOf(uid: string): TaskNode[] {
    const needle = uid.toUpperCase();
    return this.all.filter((t) => t.DependsOn.some((d) => d.toUpperCase() === needle));
  }
}

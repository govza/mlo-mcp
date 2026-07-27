import type { TaskNode } from "../types.js";
import type { Snapshot } from "../repo/mlo-repository.js";
import { findById, flatten } from "../task-tree.js";

/**
 * The identity service's view of the row store: UID -> latest captured caption.
 * PartitionStore (ticket 05) provides the real one; until then the composition
 * root wires an empty view and every resolution reads as "unconfirmed".
 */
export interface RowStoreView {
  captionOf(uid: string): string | undefined;
}

/** A RowStoreView that knows nothing — every resolution is unconfirmed. */
export const EMPTY_ROW_STORE_VIEW: RowStoreView = { captionOf: () => undefined };

export type UidResolution =
  | {
      kind: "resolved";
      uid: string;
      /**
       * confirmed: the row store holds this UID, so update/complete can author
       * from its latest full row. unconfirmed: recovered from the binary but
       * absent from the row store — a write against it will refuse with the
       * `repull` remedy (ticket 07).
       */
      confidence: "confirmed" | "unconfirmed";
    }
  | { kind: "unresolvable"; reason: "unknown-id" | "no-recoverable-guid"; detail: string };

/**
 * One owner for "which row is this id" (spec section 3): a resolver built once
 * per snapshot, aligning the export (path ids + binary-recovered GUIDs)
 * against the row store. The GUID recovery itself (guids.ts) runs where the
 * snapshot is built and arrives here as annotations — this class cross-checks
 * them against captured rows, it never re-derives them.
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
  private readonly all: TaskNode[];

  constructor(
    private readonly tasks: TaskNode[],
    private readonly rows: RowStoreView
  ) {
    this.all = flatten(tasks);
    for (const task of this.all) {
      if (task.Guid) this.byUid.set(task.Guid.toUpperCase(), task);
    }
  }

  /** Resolve a path id to the row UID a write would target — a typed refusal, never a guess. */
  uidFor(pathId: string): UidResolution {
    const task = findById(this.tasks, pathId);
    if (!task) {
      return { kind: "unresolvable", reason: "unknown-id", detail: `no task with id "${pathId}" in this snapshot` };
    }
    if (!task.Guid) {
      return {
        kind: "unresolvable",
        reason: "no-recoverable-guid",
        detail: `"${task.Caption}" has no recoverable GUID — MLO has not re-serialized it yet`,
      };
    }
    const uid = task.Guid.toUpperCase();
    const confidence = this.rows.captionOf(uid) !== undefined ? "confirmed" : "unconfirmed";
    return { kind: "resolved", uid, confidence };
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

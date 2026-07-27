import type { TaskNode } from "../types.js";
import type { MloDocument } from "../xml.js";

/**
 * A fresh export parsed into the task tree. The pending-write overlay
 * (read-your-own-writes, spec section 2) composes into this once the resident
 * write path lands.
 */
export interface Snapshot {
  doc: MloDocument;
  tasks: TaskNode[];
  at: number;
}

/**
 * One row of a sync delta, addressed to its section: a full 82-column
 * TodoItems row, a `TodoItems.Deleted` UID tombstone, a place relation, …
 * OutlineService authors these; the repository only carries them.
 */
export interface DeltaRow {
  section: string;
  values: string[];
}

/**
 * The durable-accept receipt. Keyed by writeId, not uid: two queued writes
 * can share one uid.
 */
export type WriteId = string;

export interface PendingWrite {
  writeId: WriteId;
  /** Local ISO time after which an undelivered write expires into the dead-letter file. */
  expiresAt: string;
}

/** Five-state write outcome keyed by writeId (spec section 2). */
export type WriteStatus = "accepted" | "delivered" | "verified" | "expired" | "superseded";

/**
 * A typed write refusal crossing the repository seam. Interim carrier until
 * the error-contract ticket turns every service boundary into
 * `ServiceResult` unions: the refusal is already a plain tagged value
 * (rehydrated problem+json from the resident, or the client-side
 * `endpoint-down`), only the transport up through the repository is still a
 * throw.
 */
export interface WriteRefusal {
  kind: string;
  title: string;
  retryable: boolean | "after-user-action";
  remedy?: string;
}

export class WriteRefusedError extends Error {
  constructor(readonly refusal: WriteRefusal) {
    super(refusal.remedy ? `${refusal.title} — ${refusal.remedy}` : refusal.title);
    this.name = "WriteRefusedError";
  }
}

/**
 * The one seam over MLO-as-database ([spec section 4](../../../docs/adr/0005-target-architecture-spec.md)):
 * the only code above the driver tier that touches mlo.exe, the state root, or
 * the resident process. No service ever learns a resident exists. Deliberately
 * domain-specific: one aggregate, four verbs carried as rows.
 */
export interface MloRepository {
  /**
   * Fresh export + (eventually) the pending-write overlay. `fresh` bypasses
   * the snapshot cache and never coalesces onto an in-flight refresh.
   */
  snapshot(fresh?: boolean): Promise<Snapshot>;
  /** Durably accept authored rows; resolves only once the rows are safe. */
  write(rows: DeltaRow[]): Promise<PendingWrite>;
  status(id: WriteId): Promise<WriteStatus>;
  /**
   * Best-effort sync accelerator, never load-bearing (spec section 2.5). On
   * the interface only because the `sync` tool surfaces it; it may fold away
   * once the write path owns delivery.
   */
  quickSync(): Promise<void>;
}

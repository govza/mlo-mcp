import type { TaskNode } from "../types.js";
import type { MloDocument } from "../xml.js";
import type { RehydratedProblem } from "../cloud/problem.js";
import { failureFor, REPO_FAILURE_KINDS, type RepoFailureKind } from "../error-contract.js";
import type { Failure, ServiceResult } from "../result.js";

/**
 * A fresh export parsed into the task tree, with the pending-write overlay
 * (read-your-own-writes, spec section 2) already composed in: overlaid tasks
 * carry `pending: true` and their `writeId`. Derived per read from the
 * injection queue, so it self-empties as the queue drains.
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
 * Everything known about one accept receipt. Carries the producer's own words
 * (`detail`) rather than a status alone: what makes an `expired` actionable is
 * which task it was and when it gave up, and only the write path knows that.
 */
export interface WriteState {
  writeId: WriteId;
  status: WriteStatus;
  /** The task the write addressed. */
  uid?: string;
  /** Present while the write is still queued. */
  expiresAt?: string;
  /** When the write resolved, for every state past `accepted`. */
  at?: string;
  detail?: string;
}

/**
 * The repository's closed failure union (spec section 6): infra kinds only.
 * Services map these into their own domain kinds; nothing above this seam
 * learns that a resident, an HTTP hop or mlo.exe was involved.
 *
 * Failures are values here, not throws — a refusal that travelled as an
 * exception would arrive at the tool layer as prose, and prose is exactly what
 * the contract exists to postpone until the last boundary.
 */
export interface RepoFailure extends Failure {
  kind: RepoFailureKind;
}

export type RepoResult<T> = ServiceResult<T, RepoFailure>;

/**
 * A read can only ever fail one way — the export did not happen — so the
 * snapshot seam narrows to that single kind rather than making every read
 * service handle write-path kinds it can never see.
 */
export type SnapshotFailure = Failure & { kind: "snapshot-unavailable" };

/** Build a repository failure from the contract table's declaration of the kind. */
export function repoFailure<K extends RepoFailureKind>(
  kind: K,
  detail: string,
  remedy?: string,
): Failure & { kind: K } {
  return failureFor(kind, detail, remedy);
}

/**
 * A rehydrated problem+json refusal, mapped onto the repository union. An
 * unrecognized kind is already `unknown` by the time it gets here (the wire
 * layer degrades it), so this only has to decide whether the name is one this
 * union declares.
 *
 * The wire `type` and the kind's extension members travel on: degraded is not
 * the same as lost, and a session facing a newer resident has nothing else to
 * diagnose with.
 */
export function repoFailureFromProblem(problem: RehydratedProblem): RepoFailure {
  const known = (REPO_FAILURE_KINDS as readonly string[]).includes(problem.kind);
  const kind = (known ? problem.kind : "unknown") as RepoFailureKind;
  return {
    ...failureFor(kind, problem.title, problem.remedy),
    // The producer's own declaration wins over this build's table: a newer
    // resident knows better than we do whether its refusal is retryable.
    retryable: problem.retryable,
    ...(problem.type ? { wireType: problem.type } : {}),
    ...(Object.keys(problem.extensions).length ? { fields: problem.extensions } : {}),
  };
}

/**
 * The one seam over MLO-as-database ([spec section 4](../../../docs/adr/0005-target-architecture-spec.md)):
 * the only code above the driver tier that touches mlo.exe, the state root, or
 * the resident process. No service ever learns a resident exists. Deliberately
 * domain-specific: one aggregate, four verbs carried as rows.
 */
export interface MloRepository {
  /**
   * Fresh export plus the pending-write overlay. `fresh` bypasses the snapshot
   * cache and never coalesces onto an in-flight refresh.
   */
  snapshot(fresh?: boolean): Promise<ServiceResult<Snapshot, SnapshotFailure>>;
  /** Durably accept authored rows; resolves only once the rows are safe. */
  write(rows: DeltaRow[]): Promise<RepoResult<PendingWrite>>;
  status(id: WriteId): Promise<RepoResult<WriteState>>;
  /**
   * Best-effort sync accelerator, never load-bearing (spec section 2.5). On
   * the interface only because the `sync` tool surfaces it; it may fold away
   * once the write path owns delivery.
   */
  quickSync(): Promise<RepoResult<void>>;
}

/**
 * The repository as a read-only consumer sees it. The read services
 * ([spec section 3](../../../docs/adr/0005-target-architecture-spec.md)) are
 * forbidden to know the write channel at all, so the narrowing is what makes
 * that structural rather than a promise in a comment.
 */
export type ReadRepository = Pick<MloRepository, "snapshot">;

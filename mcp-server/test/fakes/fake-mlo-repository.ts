import type { TaskNode } from "../../src/types.js";
import type { MloDocument } from "../../src/xml.js";
import {
  repoFailure,
  type DeltaRow,
  type MloRepository,
  type PendingWrite,
  type RepoResult,
  type Snapshot,
  type SnapshotFailure,
  type WriteId,
  type WriteStatus,
} from "../../src/repo/mlo-repository.js";
import type { RepoFailureKind } from "../../src/error-contract.js";
import { failed, ok, type ServiceResult } from "../../src/result.js";

const EMPTY_DOC: MloDocument = {
  "MyLifeOrganized-xml": { "@_ver": "1.2", TaskTree: { TaskNode: [] } },
};

/**
 * In-memory MloRepository: an assignable task tree and hand-driven five-state
 * write transitions (spec section 8). First cut — the full transition roster
 * (conflict-skip, stalled-session) grows with the resident write path tickets.
 */
export class FakeMloRepository implements MloRepository {
  tasks: TaskNode[] = [];
  doc: MloDocument = EMPTY_DOC;
  writeTtlMs = 15 * 60_000;
  quickSyncs = 0;

  private readonly writes = new Map<WriteId, { rows: DeltaRow[]; status: WriteStatus }>();
  private nextWriteId = 1;

  /** Set to refuse the next and every following read with `snapshot-unavailable`. */
  exportFails?: string;
  /** Set to refuse the next and every following write with this infra kind. */
  writeRefuses?: RepoFailureKind;

  async snapshot(): Promise<ServiceResult<Snapshot, SnapshotFailure>> {
    if (this.exportFails) return failed(repoFailure("snapshot-unavailable", this.exportFails));
    return ok({ doc: this.doc, tasks: this.tasks, at: Date.now() });
  }

  async write(rows: DeltaRow[]): Promise<RepoResult<PendingWrite>> {
    if (this.writeRefuses) return failed(repoFailure(this.writeRefuses, `fake repository refuses ${this.writeRefuses}`));
    const writeId: WriteId = `w${this.nextWriteId++}`;
    this.writes.set(writeId, { rows, status: "accepted" });
    return ok({ writeId, expiresAt: new Date(Date.now() + this.writeTtlMs).toISOString() });
  }

  async status(id: WriteId): Promise<RepoResult<WriteStatus>> {
    const entry = this.writes.get(id);
    if (!entry) return failed(repoFailure("unknown-write", `unknown writeId "${id}"`));
    return ok(entry.status);
  }

  async quickSync(): Promise<RepoResult<void>> {
    this.quickSyncs++;
    return ok(undefined);
  }

  /** Hand-drive a write through the five-state lifecycle. */
  transition(id: WriteId, status: WriteStatus): void {
    const entry = this.writes.get(id);
    if (!entry) throw new Error(`unknown writeId "${id}"`);
    entry.status = status;
  }
}

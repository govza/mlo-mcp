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
  type WriteReceipt,
  type WriteStatus,
} from "../../src/repo/mlo-repository.js";
import { overlayPendingWrites } from "../../src/repo/pending-overlay.js";
import { documentFromDeltaRows } from "../../src/cloud/mlo-schema.js";
import type { RowStore } from "../../src/cloud/row-store.js";
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
  /**
   * Mirrors the resident's capture-at-accept: when set, every accepted write's
   * rows are ingested with the injected-family source, exactly as
   * `WritePath.accept` does — what makes a fresh add immediately writable.
   */
  rowStore?: RowStore;

  private readonly writes = new Map<WriteId, { rows: DeltaRow[]; status: WriteStatus; expiresAt: string }>();
  private nextWriteId = 1;

  /** Set to refuse the next and every following read with `snapshot-unavailable`. */
  exportFails?: string;
  /** Set to refuse the next and every following write with this infra kind. */
  writeRefuses?: RepoFailureKind;

  async snapshot(): Promise<ServiceResult<Snapshot, SnapshotFailure>> {
    if (this.exportFails) return failed(repoFailure("snapshot-unavailable", this.exportFails));
    // The real overlay over the still-queued writes, so a test of
    // read-your-own-writes exercises the composition rather than a stand-in.
    // A write that transitioned out of `accepted` has left the queue.
    const pending = [...this.writes]
      .filter(([, write]) => write.status === "accepted")
      .map(([writeId, write]) => ({ writeId, expiresAt: write.expiresAt, rows: write.rows }));
    return ok({ doc: this.doc, tasks: overlayPendingWrites(this.tasks, pending), at: Date.now() });
  }

  async write(rows: DeltaRow[]): Promise<RepoResult<PendingWrite>> {
    if (this.writeRefuses) return failed(repoFailure(this.writeRefuses, `fake repository refuses ${this.writeRefuses}`));
    const writeId: WriteId = `w${this.nextWriteId++}`;
    const expiresAt = new Date(Date.now() + this.writeTtlMs).toISOString();
    this.writes.set(writeId, { rows, status: "accepted", expiresAt });
    await this.rowStore?.ingest(documentFromDeltaRows(rows), "injected");
    return ok({ writeId, expiresAt });
  }

  async status(id: WriteId): Promise<RepoResult<WriteReceipt>> {
    const entry = this.writes.get(id);
    if (!entry) return failed(repoFailure("unknown-write", `unknown writeId "${id}"`));
    return ok({
      writeId: id,
      status: entry.status,
      ...(entry.status === "accepted" ? { expiresAt: entry.expiresAt } : { at: new Date().toISOString() }),
    });
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

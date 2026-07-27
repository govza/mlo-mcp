import type { TaskNode } from "../../src/types.js";
import type { MloDocument } from "../../src/xml.js";
import type {
  DeltaRow,
  MloRepository,
  PendingWrite,
  Snapshot,
  WriteId,
  WriteStatus,
} from "../../src/repo/mlo-repository.js";

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

  async snapshot(): Promise<Snapshot> {
    return { doc: this.doc, tasks: this.tasks, at: Date.now() };
  }

  async write(rows: DeltaRow[]): Promise<PendingWrite> {
    const writeId: WriteId = `w${this.nextWriteId++}`;
    this.writes.set(writeId, { rows, status: "accepted" });
    return { writeId, expiresAt: new Date(Date.now() + this.writeTtlMs).toISOString() };
  }

  async status(id: WriteId): Promise<WriteStatus> {
    const entry = this.writes.get(id);
    if (!entry) throw new Error(`unknown writeId "${id}"`);
    return entry.status;
  }

  async quickSync(): Promise<void> {
    this.quickSyncs++;
  }

  /** Hand-drive a write through the five-state lifecycle. */
  transition(id: WriteId, status: WriteStatus): void {
    const entry = this.writes.get(id);
    if (!entry) throw new Error(`unknown writeId "${id}"`);
    entry.status = status;
  }
}

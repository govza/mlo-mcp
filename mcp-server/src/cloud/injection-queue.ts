import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, WriteChain } from "./atomic-file.js";
import type { DeltaRow, WriteId } from "../repo/mlo-repository.js";

/**
 * The durable store behind the write path's accept (spec section 2): rows are
 * fsync'd here before `accepted` is ever returned, so a kill after accept
 * preserves the write. The resident is the single writer (reached via
 * `POST /v1/write`); the delivery loop, TTL expiry, and Apply observation that
 * consume this queue arrive with the resident write path (migration step 6) —
 * this module owns only the durable state.
 */

export interface QueuedWrite {
  writeId: WriteId;
  /** The row UID the write targets — the injection gate compares against the binding, delivery against Apply. */
  uid: string;
  verb: "add" | "update" | "complete" | "delete";
  /** For the dead-letter record a TTL expiry writes — the human-readable identity of the attempt. */
  caption?: string;
  rows: DeltaRow[];
  queuedAt: string;
  expiresAt: string;
}

export interface InjectionQueue {
  /** Resolves only after the queue file is fsync'd — the durable half of "accepted". */
  enqueue(write: QueuedWrite): Promise<void>;
  /** Every queued write, oldest first. */
  pending(): Promise<QueuedWrite[]>;
  /** Take one write out (delivered, superseded, or expired); returns what was removed. */
  remove(writeId: WriteId): Promise<QueuedWrite | undefined>;
}

interface QueueFile {
  writes: QueuedWrite[];
  at: string;
}

const FILE_NAME = "injection-queue.json";

export class FileInjectionQueue implements InjectionQueue {
  private readonly writes = new WriteChain();

  constructor(private readonly dir: string) {}

  private file(): string {
    return path.join(this.dir, FILE_NAME);
  }

  private async load(): Promise<QueuedWrite[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), "utf8")) as Partial<QueueFile>;
      return (parsed.writes ?? []).filter((write) => typeof write?.writeId === "string");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  }

  /**
   * Write-fsync-rename: the temp file is flushed to disk before it replaces
   * the queue, so the rename either exposes a durable file or nothing.
   */
  private save(writes: QueuedWrite[]): Promise<void> {
    const value: QueueFile = { writes, at: new Date().toISOString() };
    return atomicWrite(this.file(), JSON.stringify(value), { fsync: true });
  }

  enqueue(write: QueuedWrite): Promise<void> {
    return this.writes.run(async () => {
      const writes = await this.load();
      if (writes.some((queued) => queued.writeId === write.writeId)) {
        throw new Error(`writeId ${write.writeId} is already queued — writeIds are accept receipts, never reused`);
      }
      await this.save([...writes, write]);
    });
  }

  pending(): Promise<QueuedWrite[]> {
    return this.load();
  }

  remove(writeId: WriteId): Promise<QueuedWrite | undefined> {
    return this.writes.run(async () => {
      const writes = await this.load();
      const index = writes.findIndex((write) => write.writeId === writeId);
      if (index < 0) return undefined;
      const [removed] = writes.splice(index, 1);
      await this.save(writes);
      return removed;
    });
  }
}

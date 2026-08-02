import path from "node:path";
import { JsonDocument } from "./json-document.js";
import type { DeltaRow, WriteId, WriteVerb } from "../repo/mlo-repository.js";

/**
 * The durable store behind the write path's accept (spec section 2): rows are
 * fsync'd here before `accepted` is ever returned, so a kill after accept
 * preserves the write. The resident is the single writer (reached via
 * `POST /v1/write`); the delivery loop, TTL expiry, and Apply observation that
 * consume this queue live on the PartitionStore handle — this module owns only
 * the durable state.
 */

export type { WriteVerb };

export interface QueuedWrite {
  writeId: WriteId;
  /** The row UID the write targets — the injection gate compares against the binding, delivery against Apply. */
  uid: string;
  verb: WriteVerb;
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

const FILE_NAME = "injection-queue.json";

export class FileInjectionQueue implements InjectionQueue {
  private readonly document: JsonDocument<QueuedWrite[]>;

  constructor(dir: string) {
    this.document = new JsonDocument(path.join(dir, FILE_NAME), {
      unwrap: (parsed) =>
        ((parsed as { writes?: QueuedWrite[] }).writes ?? []).filter((write) => typeof write?.writeId === "string"),
      wrap: (writes) => ({ writes, at: new Date().toISOString() }),
      empty: () => [],
      // Durable accepts, so the file is flushed before the rename, and a
      // corrupt queue throws rather than silently dropping accepted writes.
      fsync: true,
    });
  }

  enqueue(write: QueuedWrite): Promise<void> {
    return this.document.update((writes) => {
      if (writes.some((queued) => queued.writeId === write.writeId)) {
        throw new Error(`writeId ${write.writeId} is already queued — writeIds are accept receipts, never reused`);
      }
      return { value: [...writes, write], result: undefined };
    });
  }

  pending(): Promise<QueuedWrite[]> {
    return this.document.read();
  }

  remove(writeId: WriteId): Promise<QueuedWrite | undefined> {
    return this.document.update((writes) => {
      const index = writes.findIndex((write) => write.writeId === writeId);
      if (index < 0) return { value: writes, result: undefined };
      const next = [...writes];
      const [removed] = next.splice(index, 1);
      return { value: next, result: removed };
    });
  }
}

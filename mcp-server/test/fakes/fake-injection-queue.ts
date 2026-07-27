import type { InjectionQueue, QueuedWrite } from "../../src/cloud/injection-queue.js";
import type { WriteId } from "../../src/repo/mlo-repository.js";

/** In-memory InjectionQueue — durability faked away, semantics identical. */
export class FakeInjectionQueue implements InjectionQueue {
  private writes: QueuedWrite[] = [];

  async enqueue(write: QueuedWrite): Promise<void> {
    if (this.writes.some((queued) => queued.writeId === write.writeId)) {
      throw new Error(`writeId ${write.writeId} is already queued — writeIds are accept receipts, never reused`);
    }
    this.writes.push(write);
  }

  async pending(): Promise<QueuedWrite[]> {
    return [...this.writes];
  }

  async remove(writeId: WriteId): Promise<QueuedWrite | undefined> {
    const index = this.writes.findIndex((write) => write.writeId === writeId);
    if (index < 0) return undefined;
    return this.writes.splice(index, 1)[0];
  }
}

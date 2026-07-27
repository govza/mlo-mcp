import { promises as fs } from "node:fs";

/**
 * Replace `target` via temp-file rename, so readers see the old file or the
 * new one, never a torn write. `fsync` additionally flushes the temp file
 * before the rename — the durable-accept variant, where the rename must
 * expose a file that survives a process kill.
 */
export async function atomicWrite(target: string, text: string, options?: { fsync?: boolean }): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  if (options?.fsync) {
    const handle = await fs.open(temporary, "w");
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await fs.writeFile(temporary, text);
  }
  await fs.rename(temporary, target);
}

/**
 * In-process write serialization: one file, one writer at a time, callers
 * queued in arrival order. The cross-process variant is StateRootLock; this
 * one is for files with a single writing process (the resident).
 */
export class WriteChain {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

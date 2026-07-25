import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Mutual exclusion over one file in the state root, across processes.
 *
 * A state root is shared by every MCP session on the machine, so a
 * read-modify-write of a file in it is not safe under an in-process promise
 * chain alone: two sessions each read, each append, and the second rename
 * drops the first's entry — or, on Windows, loses the race outright with
 * `EPERM`. `mkdir` is the atomic primitive available on NTFS, so the lock is a
 * directory; the stale timeout is what stops a killed process from wedging the
 * root forever, and the chain on top keeps one process's own concurrent calls
 * off the filesystem entirely.
 *
 * Each lock takes a `name` so unrelated files in the same root do not contend.
 */
export class StateRootLock {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly stateRoot: string,
    readonly name: string,
  ) {}

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockDir = path.join(this.stateRoot, `.${this.name}-lock`);
    const deadline = Date.now() + 10_000;
    await fs.mkdir(this.stateRoot, { recursive: true });
    for (;;) {
      try {
        await fs.mkdir(lockDir);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(lockDir);
          if (Date.now() - stat.mtimeMs > 30_000) {
            await fs.rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${this.name} lock: ${lockDir}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  /** Run `operation` with the lock held, queued behind this process's own calls. */
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.withLock(operation);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

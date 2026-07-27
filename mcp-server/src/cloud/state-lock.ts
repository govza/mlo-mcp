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
      await this.release(lockDir);
    }
  }

  /**
   * Drop the lock directory. On Windows a directory whose handle the OS has
   * not finished closing answers `EBUSY` to `rmdir`, and `force` does not
   * cover that one — a release is not a failure, so it may never surface as
   * the operation's own error. A few short attempts clear it in practice, and
   * the stale timeout above is the backstop if they do not. Any other error is
   * left to the same backstop rather than replacing the caller's result.
   */
  private async release(lockDir: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fs.rm(lockDir, { recursive: true, force: true });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY") return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
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

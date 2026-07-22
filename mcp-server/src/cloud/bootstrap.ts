import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeDataFileUid, type PartitionMode } from "./partition.js";

/**
 * The one-time bootstrap window.
 *
 * Bootstrap detection is "explicitly armed session + validated full-snapshot
 * coverage", never a counter value: the captured re-synchronize session's
 * `lastSyncTimestamp` value was not retained, so no numeric heuristic is
 * trustworthy. While armed, exactly ONE previously unknown `dataFileUID` may
 * introduce itself; a second unknown UID disarms the window and fails closed
 * (that is precisely how a second profile syncing through the same endpoint
 * once contaminated an unpartitioned log).
 *
 * The marker is persisted at the state root so attached (listener-less)
 * sessions and restarts observe the same window; the staged upload survives
 * for idempotent re-validation after a crash or an in-window retry.
 */
export interface ArmedWindow {
  profilePath: string;
  mode: PartitionMode;
  armedAt: string;
  expiresAt: string;
  /** Set once the bidirectional precondition was observed: an empty Get before the upload. */
  sawEmptyGet?: boolean;
  /** The single unknown dataFileUID accepted by this window, once seen. */
  dataFileUID?: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class BootstrapController {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly stateRoot: string) {}

  private dir(): string {
    return path.join(this.stateRoot, "bootstrap");
  }

  private markerPath(): string {
    return path.join(this.dir(), "armed.json");
  }

  stagedPath(): string {
    return path.join(this.dir(), "staged.zip");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<ArmedWindow | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.markerPath(), "utf8")) as ArmedWindow;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  private async write(window: ArmedWindow): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
    const target = this.markerPath();
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(temporary, `${JSON.stringify(window, null, 2)}\n`);
    await fs.rename(temporary, target);
  }

  /** The active window, expiring it lazily. */
  async current(): Promise<ArmedWindow | undefined> {
    return this.serialize(async () => {
      const window = await this.read();
      if (!window) return undefined;
      if (Date.parse(window.expiresAt) <= Date.now()) {
        await this.remove();
        return undefined;
      }
      return window;
    });
  }

  /** Arm for one profile. A live window for a different profile fails closed. */
  async arm(profilePath: string, mode: PartitionMode, ttlMs = DEFAULT_TTL_MS): Promise<ArmedWindow> {
    return this.serialize(async () => {
      const existing = await this.read();
      if (existing && Date.parse(existing.expiresAt) > Date.now() && existing.profilePath !== profilePath) {
        throw new Error(
          `a bootstrap window is already armed for a different profile (${existing.profilePath}); ` +
          "wait for it to complete or expire",
        );
      }
      const now = Date.now();
      const window: ArmedWindow = {
        profilePath,
        mode,
        armedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      };
      await this.write(window);
      await fs.rm(this.stagedPath(), { force: true });
      return window;
    });
  }

  /**
   * Record the unknown `dataFileUID` introducing itself to the armed window.
   * Exactly one is accepted; a different one disarms and fails closed.
   */
  async noteUidSeen(rawUid: string): Promise<void> {
    const uid = normalizeDataFileUid(rawUid);
    await this.serialize(async () => {
      const window = await this.read();
      if (!window) throw new Error("no bootstrap window is armed");
      if (!window.dataFileUID) {
        await this.write({ ...window, dataFileUID: uid });
        return;
      }
      if (window.dataFileUID !== uid) {
        await this.remove();
        throw new Error(
          "a second unknown dataFileUID appeared during the bootstrap window — disarmed; " +
          "make sure only the target profile syncs during bootstrap, then re-run cloud_bootstrap",
        );
      }
    });
  }

  async noteEmptyGetServed(): Promise<void> {
    await this.serialize(async () => {
      const window = await this.read();
      if (window && !window.sawEmptyGet) await this.write({ ...window, sawEmptyGet: true });
    });
  }

  /** Persist the candidate snapshot bytes for idempotent (re)validation. */
  async stageSnapshot(bytes: Uint8Array): Promise<void> {
    await this.serialize(async () => {
      await fs.mkdir(this.dir(), { recursive: true });
      const target = this.stagedPath();
      const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(temporary, bytes);
      await fs.rename(temporary, target);
    });
  }

  /** Close the window after success; the staged upload is no longer needed. */
  async complete(): Promise<void> {
    await this.serialize(() => this.remove());
  }

  async disarm(): Promise<void> {
    await this.serialize(() => this.remove());
  }

  private async remove(): Promise<void> {
    await fs.rm(this.markerPath(), { force: true });
    await fs.rm(this.stagedPath(), { force: true });
  }
}

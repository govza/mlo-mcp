import type { MloConfig } from "../types.js";
import { parseMloXml } from "../xml.js";
import { buildTaskTree } from "../task-tree.js";
import { annotateGuids } from "../guids.js";
import { log } from "../log.js";
import type { MloCli } from "./mlo-cli.js";
import type { ResidentClient } from "./resident-client.js";
import {
  repoFailure,
  repoFailureFromProblem,
  type DeltaRow,
  type MloRepository,
  type PendingWrite,
  type RepoResult,
  type Snapshot,
  type SnapshotFailure,
  type WriteId,
  type WriteState,
} from "./mlo-repository.js";
import { overlayPendingWrites, type PendingReader, type PendingRows } from "./pending-overlay.js";
import { failed, ok, type ServiceResult } from "../result.js";

/**
 * The session-side MloRepository implementation. Reads go through the
 * constructor-injected MloCli driver with a short-lived snapshot cache that
 * only smooths bursts of reads. Writes cross the process seam through the
 * constructor-injected ResidentClient driver: `write` is the resident's
 * durable accept, `status` its five-state answer, and every refusal arrives
 * as a typed value the driver rehydrated from problem+json.
 */
export class LocalMloRepository implements MloRepository {
  private snap?: Snapshot;
  private pending?: Promise<Snapshot>;
  /** When the last QuickSync fired — write nudges within the debounce window ride MLO's own poll instead. */
  private lastQuickSyncAt = 0;

  constructor(
    private readonly config: MloConfig,
    private readonly cli: MloCli,
    /** Absent only in read-only wirings (tests); writes then refuse loudly. */
    private readonly resident?: ResidentClient,
    /**
     * The bound partition's injection queue, read (never written) for the
     * read-your-own-writes overlay. Absent while the profile is unbound —
     * there is no queue to read, and no write could have been accepted either.
     */
    private readonly queue?: PendingReader,
  ) {}

  async snapshot(fresh = false): Promise<ServiceResult<Snapshot, SnapshotFailure>> {
    try {
      const snapshot = await this.exported(fresh);
      const tasks = overlayPendingWrites(snapshot.tasks, await this.queuedWrites());
      // The cached export stays export truth; the overlay is composed per read
      // so a drained queue needs no invalidation to disappear.
      return ok(tasks === snapshot.tasks ? snapshot : { ...snapshot, tasks });
    } catch (error) {
      // Expected, not exceptional: mlo.exe is a single-instance app that
      // refuses to export while it is busy, and the caller's remedy is to ask
      // again in a moment rather than to see a stack trace.
      return failed(
        repoFailure(
          "snapshot-unavailable",
          `could not export the profile: ${error instanceof Error ? error.message : String(error)}`,
          "try again in a moment — MLO refuses to export while a dialog or another operation holds the profile",
        ),
      );
    }
  }

  /**
   * The queue as the overlay sees it. An unreadable queue serves export truth
   * rather than failing the read: a read is not the surface a state-root fault
   * belongs on (`cloud_status` refuses out loud), and the export is still the
   * honest answer to what MLO holds.
   */
  private async queuedWrites(): Promise<PendingRows[]> {
    if (!this.queue) return [];
    try {
      return await this.queue.pending();
    } catch (error) {
      log(`pending-write overlay skipped (reads fall back to export truth): ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async exported(fresh: boolean): Promise<Snapshot> {
    if (!fresh && this.snap && Date.now() - this.snap.at < this.config.cacheStaleMs) {
      return this.snap;
    }
    // fresh=true must not coalesce onto an in-flight refresh: its export may
    // have started before the caller's mutation and would read as pre-change.
    if (fresh) this.pending = undefined;
    if (!this.pending) {
      const promise: Promise<Snapshot> = this.refresh()
        .then((snapshot) => {
          // a superseded refresh must not overwrite a newer snapshot
          if (this.pending === promise) this.snap = snapshot;
          return snapshot;
        })
        .finally(() => {
          if (this.pending === promise) this.pending = undefined;
        });
      this.pending = promise;
    }
    return this.pending;
  }

  private async refresh(): Promise<Snapshot> {
    const xml = await this.cli.exportXml();
    const doc = parseMloXml(xml);
    const tasks = buildTaskTree(doc);
    try {
      annotateGuids(await this.cli.readDataFile(), tasks);
    } catch (e) {
      log(`GUID extraction failed (continuing without GUIDs): ${(e as Error).message}`);
    }
    return { doc, tasks, at: Date.now() };
  }

  invalidate(): void {
    this.snap = undefined;
    this.pending = undefined;
  }

  private requireResident(): ResidentClient {
    if (!this.resident) {
      throw new Error("this repository was wired without a ResidentClient — a read-only wiring cannot write");
    }
    return this.resident;
  }

  async write(rows: DeltaRow[]): Promise<RepoResult<PendingWrite>> {
    const result = await this.requireResident().postWrite({ profile: this.config.dataFile, rows });
    if (!result.ok) return failed(repoFailureFromProblem(result.refusal));
    // Best-effort accelerator, never load-bearing (spec section 2 mechanic 5):
    // fire-and-forget so the accept receipt returns now, and a QuickSync that
    // fails or no-ops just leaves delivery to MLO's own cadence. Debounced
    // because MLO throttles the deprecated -QuickSync switch with a modal
    // ("sync no more than once per several minutes"); within-window writes
    // sit in the queue and ride MLO's background GetFileTS poll, which
    // delivers all pending writes in one session.
    if (Date.now() - this.lastQuickSyncAt >= this.config.quickSyncDebounceMs) {
      void this.quickSync().then((nudge) => {
        if (nudge.isErrored) {
          log(`QuickSync nudge after accept failed (delivery rides MLO's own cadence): ${nudge.failure.detail}`);
        }
      });
    }
    return ok({ writeId: result.value.writeId, expiresAt: result.value.expiresAt });
  }

  async status(id: WriteId): Promise<RepoResult<WriteState>> {
    const result = await this.requireResident().writeStatus(id);
    if (!result.ok) return failed(repoFailureFromProblem(result.refusal));
    const state = result.value;
    return ok({
      writeId: state.writeId,
      status: state.status,
      ...(state.uid ? { uid: state.uid } : {}),
      ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
      ...(state.at ? { at: state.at } : {}),
      ...(state.detail ? { detail: state.detail } : {}),
    });
  }

  async quickSync(): Promise<RepoResult<void>> {
    // Stamped for every invocation, explicit or nudge, even one that fails:
    // MLO's throttle counts invocation attempts, and an explicit sync also
    // opens the debounce window, so a write right after it does not re-fire.
    this.lastQuickSyncAt = Date.now();
    try {
      await this.cli.quickSync();
    } catch (error) {
      return failed(
        repoFailure("quick-sync-failed", error instanceof Error ? error.message : String(error)),
      );
    }
    // a sync can change the data file, so the stale snapshot dies here, not at the caller
    this.invalidate();
    return ok(undefined);
  }
}

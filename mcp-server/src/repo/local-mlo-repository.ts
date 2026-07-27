import type { MloConfig } from "../types.js";
import { parseMloXml } from "../xml.js";
import { buildTaskTree } from "../task-tree.js";
import { annotateGuids } from "../guids.js";
import { log } from "../log.js";
import type { MloCli } from "./mlo-cli.js";
import type { DeltaRow, MloRepository, PendingWrite, Snapshot, WriteId, WriteStatus } from "./mlo-repository.js";

/**
 * The session-side MloRepository implementation. Reads go through the
 * constructor-injected MloCli driver with a short-lived snapshot cache that
 * only smooths bursts of reads. `write`/`status` are stubs until the resident
 * injection queue lands (ADR-0005 migration step 6) — the seam shape is what
 * exists today.
 */
export class LocalMloRepository implements MloRepository {
  private snap?: Snapshot;
  private pending?: Promise<Snapshot>;

  constructor(
    private readonly config: MloConfig,
    private readonly cli: MloCli
  ) {}

  async snapshot(fresh = false): Promise<Snapshot> {
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

  async write(_rows: DeltaRow[]): Promise<PendingWrite> {
    throw new Error("the write path is not wired yet — writes land with the resident injection queue (ADR-0005 migration step 6)");
  }

  async status(_id: WriteId): Promise<WriteStatus> {
    throw new Error("the write path is not wired yet — writes land with the resident injection queue (ADR-0005 migration step 6)");
  }

  async quickSync(): Promise<void> {
    await this.cli.quickSync();
    // a sync can change the data file, so the stale snapshot dies here, not at the caller
    this.invalidate();
  }
}

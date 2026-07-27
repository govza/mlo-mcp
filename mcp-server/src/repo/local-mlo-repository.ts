import type { MloConfig } from "../types.js";
import { parseMloXml } from "../xml.js";
import { buildTaskTree } from "../task-tree.js";
import { annotateGuids } from "../guids.js";
import { log } from "../log.js";
import type { MloCli } from "./mlo-cli.js";
import type { ResidentClient } from "./resident-client.js";
import {
  WriteRefusedError,
  type DeltaRow,
  type MloRepository,
  type PendingWrite,
  type Snapshot,
  type WriteId,
  type WriteStatus,
} from "./mlo-repository.js";

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

  constructor(
    private readonly config: MloConfig,
    private readonly cli: MloCli,
    /** Absent only in read-only wirings (tests); writes then refuse loudly. */
    private readonly resident?: ResidentClient,
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

  private requireResident(): ResidentClient {
    if (!this.resident) {
      throw new Error("this repository was wired without a ResidentClient — a read-only wiring cannot write");
    }
    return this.resident;
  }

  async write(rows: DeltaRow[]): Promise<PendingWrite> {
    const result = await this.requireResident().postWrite({ profile: this.config.dataFile, rows });
    if (!result.ok) throw new WriteRefusedError(result.refusal);
    // Best-effort accelerator, never load-bearing (spec section 2 mechanic 5):
    // fire-and-forget so the accept receipt returns now, and a QuickSync that
    // fails or no-ops just leaves delivery to MLO's own cadence.
    void this.quickSync().catch((error) =>
      log(`QuickSync nudge after accept failed (delivery rides MLO's own cadence): ${error instanceof Error ? error.message : String(error)}`));
    return { writeId: result.value.writeId, expiresAt: result.value.expiresAt };
  }

  async status(id: WriteId): Promise<WriteStatus> {
    const result = await this.requireResident().writeStatus(id);
    if (!result.ok) throw new WriteRefusedError(result.refusal);
    return result.value.status;
  }

  async quickSync(): Promise<void> {
    await this.cli.quickSync();
    // a sync can change the data file, so the stale snapshot dies here, not at the caller
    this.invalidate();
  }
}

import type { MloConfig, TaskNode } from "./types.js";
import type { MloDocument } from "./xml.js";
import { parseMloXml } from "./xml.js";
import { buildTaskTree } from "./task-tree.js";
import { annotateGuids } from "./guids.js";
import { exportXml, readDataFile } from "./mlo-cli.js";
import { log } from "./log.js";

export interface Snapshot {
  xml: string;
  doc: MloDocument;
  tasks: TaskNode[];
  /** how many tasks got a GUID from the binary */
  guidCount: number;
  at: number;
}

/**
 * Cached view of the task tree. Every read tool goes through getSnapshot();
 * every mutation calls invalidate(). The cache only smooths bursts of reads —
 * mutations always re-export first before resolving ids.
 */
export class MloStore {
  private snap?: Snapshot;
  private pending?: Promise<Snapshot>;

  constructor(readonly config: MloConfig) {}

  async getSnapshot(fresh = false): Promise<Snapshot> {
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
    const xml = await exportXml(this.config);
    const doc = parseMloXml(xml);
    const tasks = buildTaskTree(doc);
    let guidCount = 0;
    try {
      guidCount = annotateGuids(await readDataFile(this.config), tasks);
    } catch (e) {
      log(`GUID extraction failed (continuing without GUIDs): ${(e as Error).message}`);
    }
    return { xml, doc, tasks, guidCount, at: Date.now() };
  }

  invalidate(): void {
    this.snap = undefined;
    this.pending = undefined;
  }
}

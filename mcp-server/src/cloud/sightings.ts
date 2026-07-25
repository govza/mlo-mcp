import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../log.js";

/**
 * A sync arrived for a `dataFileUID` this server has no binding for.
 *
 * The endpoint deliberately stays out of the way of profiles it was not asked
 * to manage: such a request is forwarded to the vendor unchanged and nothing
 * is captured. That branch also hides the opposite case — the BOUND profile
 * syncing under a new identity — because `cloud_status` sources the UID from
 * the binding and so agrees with itself no matter how stale that binding is.
 * The sighting is the only evidence of the difference, and it is persisted
 * because the in-memory vendor contacts cannot outlive the process that
 * captured them, by design: an attached MCP client and the next server run
 * must both be able to read it.
 */
export interface UnboundSighting {
  dataFileUID: string;
  firstSeen: string;
  lastSeen: string;
  /** Authority decisions for this UID — sync sessions, not single operations. */
  count: number;
}

interface SightingsFile {
  sightings: UnboundSighting[];
  at: string;
}

/** Keep the most recent few: this is a diagnostic marker, not a log. */
const MAX_SIGHTINGS = 8;

/**
 * The persisted sighting marker, one per state root. Only the process holding
 * the listener ever writes it — attached processes read it — so the write is a
 * temp-file rename with an in-process chain rather than the cross-process lock
 * the bindings and delta logs need.
 */
export class SightingStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly stateRoot: string) {}

  private file(): string {
    return path.join(this.stateRoot, "unbound-sightings.json");
  }

  /** Every recorded sighting, most recently seen first. */
  async all(): Promise<UnboundSighting[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), "utf8")) as Partial<SightingsFile>;
      return (parsed.sightings ?? []).filter((sighting) => typeof sighting?.dataFileUID === "string");
    } catch (error) {
      // Absent is the normal case. Anything else is reported rather than
      // swallowed: this file is the only evidence of the fault it describes.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`could not read the unbound-sighting marker (treated as empty): ${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    }
  }

  /** Record one sync by an unbound profile. `uid` must already be normalized. */
  async note(uid: string): Promise<void> {
    const run = async () => {
      const sightings = await this.all();
      const now = new Date().toISOString();
      const existing = sightings.find((sighting) => sighting.dataFileUID === uid);
      if (existing) {
        existing.lastSeen = now;
        existing.count += 1;
      } else {
        sightings.push({ dataFileUID: uid, firstSeen: now, lastSeen: now, count: 1 });
      }
      sightings.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      const value: SightingsFile = { sightings: sightings.slice(0, MAX_SIGHTINGS), at: now };
      const target = this.file();
      const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
      await fs.rename(temporary, target);
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    await next;
  }
}

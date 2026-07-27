import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, WriteChain } from "./atomic-file.js";
import { log } from "../log.js";
import type { WriteVerb } from "./injection-queue.js";
import type { WriteId } from "../repo/mlo-repository.js";

/**
 * The durable record of every write that LEFT the injection queue (spec
 * section 2): delivered (MLO's Apply carried it with matching content),
 * superseded (same UID, differing content — a conflict-dialog local-wins), or
 * expired (TTL ran out, the row is in the dead-letter file). `write_status`
 * answers from here once a write is no longer queued, and `cloud_status`'s
 * aggregate reads the recent tail. Event tier: recorded and visible, blocking
 * nothing.
 */

export type ResolvedWriteStatus = "delivered" | "superseded" | "expired";

export interface WriteOutcome {
  writeId: WriteId;
  uid: string;
  verb: WriteVerb;
  caption?: string;
  status: ResolvedWriteStatus;
  at: string;
  detail?: string;
}

export interface WriteOutcomeStore {
  record(outcome: WriteOutcome): Promise<void>;
  /** Every retained outcome, oldest first. */
  all(): Promise<WriteOutcome[]>;
  byId(writeId: WriteId): Promise<WriteOutcome | undefined>;
}

interface OutcomeFile {
  outcomes: WriteOutcome[];
  at: string;
}

const FILE_NAME = "write-outcomes.json";
/** Bounded: a receipt older than the ring is one nobody is coming back for. */
export const DEFAULT_OUTCOME_CAP = 200;

export class FileWriteOutcomes implements WriteOutcomeStore {
  private readonly writes = new WriteChain();

  constructor(
    private readonly dir: string,
    private readonly cap = DEFAULT_OUTCOME_CAP,
  ) {}

  private file(): string {
    return path.join(this.dir, FILE_NAME);
  }

  private async load(): Promise<WriteOutcome[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), "utf8")) as Partial<OutcomeFile>;
      return (parsed.outcomes ?? []).filter((outcome) => typeof outcome?.writeId === "string");
    } catch (error) {
      // Absent is the normal case. Corrupt is evidence lost, not a wedge.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`could not read the write-outcome file (treated as empty): ${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    }
  }

  record(outcome: WriteOutcome): Promise<void> {
    return this.writes.run(async () => {
      const outcomes = [...(await this.load()), outcome];
      const value: OutcomeFile = { outcomes: outcomes.slice(-this.cap), at: outcome.at };
      await atomicWrite(this.file(), `${JSON.stringify(value)}\n`);
    });
  }

  all(): Promise<WriteOutcome[]> {
    return this.load();
  }

  async byId(writeId: WriteId): Promise<WriteOutcome | undefined> {
    // Last match wins: writeIds are never reused, but if a record were ever
    // duplicated the newest reading is the honest one.
    return (await this.load()).findLast((outcome) => outcome.writeId === writeId);
  }
}

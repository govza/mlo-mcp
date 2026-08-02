import path from "node:path";
import { JsonDocument } from "./json-document.js";
import type { WriteId, WriteVerb } from "../repo/mlo-repository.js";

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

const FILE_NAME = "write-outcomes.json";
/** Bounded: a receipt older than the ring is one nobody is coming back for. */
export const DEFAULT_OUTCOME_CAP = 200;

export class FileWriteOutcomes implements WriteOutcomeStore {
  private readonly document: JsonDocument<WriteOutcome[]>;

  constructor(dir: string, private readonly cap = DEFAULT_OUTCOME_CAP) {
    this.document = new JsonDocument(path.join(dir, FILE_NAME), {
      unwrap: (parsed) =>
        ((parsed as { outcomes?: WriteOutcome[] }).outcomes ?? []).filter((outcome) => typeof outcome?.writeId === "string"),
      wrap: (outcomes) => ({ outcomes, at: outcomes.at(-1)?.at ?? new Date().toISOString() }),
      empty: () => [],
      // Absent is the normal case. Corrupt is evidence lost, not a wedge.
      onCorrupt: "empty",
    });
  }

  record(outcome: WriteOutcome): Promise<void> {
    return this.document.update((outcomes) => ({
      value: [...outcomes, outcome].slice(-this.cap),
      result: undefined,
    }));
  }

  all(): Promise<WriteOutcome[]> {
    return this.document.read();
  }

  async byId(writeId: WriteId): Promise<WriteOutcome | undefined> {
    // Last match wins: writeIds are never reused, but if a record were ever
    // duplicated the newest reading is the honest one.
    return (await this.document.read()).findLast((outcome) => outcome.writeId === writeId);
  }
}

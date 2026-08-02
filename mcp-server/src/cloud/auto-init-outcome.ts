import path from "node:path";
import { JsonDocument } from "./json-document.js";
import type { Problem } from "./problem.js";

/**
 * The persisted result of the last auto-init attempt that decided anything.
 *
 * The resident is spawned detached with its stdio discarded, so a declined
 * bind logs its reason into the void. This marker is that reason, written
 * where an attached MCP session can read it: `cloud_status` shows an unbound
 * profile AND why the endpoint's last attempt to fix that declined.
 *
 * The steady-state `already-bound` answer is deliberately not recorded — it
 * carries no diagnostic weight and would overwrite the one entry that does.
 */
export type AutoInitOutcome =
  | { kind: "bound"; at: string; profilePath: string; dataFileUID: string }
  | { kind: "refused"; at: string; problem: Problem };

/** A marker missing the fields its kind promises is treated as absent. */
function unwrap(parsed: unknown): AutoInitOutcome | undefined {
  const value = parsed as Partial<AutoInitOutcome> | null;
  if (!value || typeof value.at !== "string") return undefined;
  if (value.kind === "bound" && typeof value.dataFileUID === "string" && typeof value.profilePath === "string") {
    return value as AutoInitOutcome;
  }
  if (value.kind === "refused" && typeof value.problem === "object" && value.problem !== null) {
    return value as AutoInitOutcome;
  }
  return undefined;
}

/**
 * One marker per state root, like the sighting store: only the process holding
 * the listener writes it, attached processes read it. Diagnostic evidence, not
 * durable state — a corrupt file degrades to "no marker" rather than wedging.
 */
export class AutoInitOutcomeStore {
  private readonly document: JsonDocument<AutoInitOutcome | undefined>;

  constructor(readonly stateRoot: string) {
    this.document = new JsonDocument(path.join(stateRoot, "auto-init-outcome.json"), {
      unwrap,
      wrap: (value) => value ?? null,
      empty: () => undefined,
      onCorrupt: "empty",
      pretty: true,
    });
  }

  /** The last decisive attempt, or undefined when none has been recorded. */
  last(): Promise<AutoInitOutcome | undefined> {
    return this.document.read();
  }

  /** Replace the marker. Best-effort by contract: callers never await a failure. */
  record(outcome: AutoInitOutcome): Promise<void> {
    return this.document.update(() => ({ value: outcome, result: undefined }));
  }
}

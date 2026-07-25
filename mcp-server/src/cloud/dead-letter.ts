import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { StateRootLock } from "./state-lock.js";

/**
 * The text of a write the server refused.
 *
 * Every refusal path is loud and queues nothing, which is the right behaviour
 * and is aimed at an agent that will handle the error. A capture is different:
 * its whole premise is that the user has already moved on, so the refusal lands
 * in a panel nobody is reading — and in Claude Code that panel is an in-memory
 * ring buffer, so closing the window takes the text with it. The server did not
 * lose anything; the channel did. What is irreplaceable is not the task, which
 * can always be re-added, but the sentence the user typed.
 *
 * Deliberately NOT a queue: no ordering, no duplicate detection, no lifecycle,
 * and nothing here is ever replayed. A refusal means something is actually
 * wrong, and writing on top of it is how ADR-0002's failure mode gets
 * reinvented. Recovery is reading the file by hand.
 */
export interface DeadLetter {
  at: string;
  /**
   * The tool that authored the delta, which is not always the tool the caller
   * named: `add_task` is a single-entry batch, so its refusals read
   * `add_tasks`. The words below are what identifies the attempt.
   */
  tool: string;
  /** The refusal verbatim, so a recovered capture says which fault dropped it. */
  reason: string;
  /** The caller's own words — the part that cannot be reconstructed. */
  content: string;
}

interface DeadLetterFile {
  refused: DeadLetter[];
  at: string;
}

/**
 * Bounded twice over, because either dimension alone leaves it unbounded: a
 * fault that persists for days caps out at MAX_LETTERS entries, and one
 * enormous note cannot inflate a single entry past MAX_CONTENT.
 */
const MAX_LETTERS = 50;
const MAX_CONTENT = 4000;

function clamp(content: string): string {
  return content.length <= MAX_CONTENT ? content : `${content.slice(0, MAX_CONTENT)}… (truncated)`;
}

/**
 * The persisted dead-letter marker, one per state root.
 *
 * Unlike the sighting marker next door, this one is NOT written only by the
 * process holding the listener: every attached session that refuses a write
 * appends, and the refusal for a missing vendor contact fires *specifically*
 * in sessions that do not own the endpoint. So it takes the cross-process lock
 * the bindings use rather than sightings' in-process chain — without it two
 * sessions refusing at the same moment lose one of the two captures, which is
 * the single thing this file exists to prevent.
 */
export class DeadLetterStore {
  private readonly lock: StateRootLock;

  constructor(readonly stateRoot: string) {
    this.lock = new StateRootLock(stateRoot, "dead-letters");
  }

  /** The path a refusal names, so recovery does not require knowing the state root. */
  file(): string {
    return path.join(this.stateRoot, "dead-letters.json");
  }

  /** Every preserved write, oldest first. */
  async all(): Promise<DeadLetter[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), "utf8")) as Partial<DeadLetterFile>;
      return (parsed.refused ?? []).filter((letter) => typeof letter?.content === "string");
    } catch (error) {
      // Absent is the normal case — most profiles never refuse a write.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`could not read the dead-letter file (treated as empty): ${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    }
  }

  /** Append one refused write; the oldest fall off the front once full. */
  async record(letter: DeadLetter): Promise<void> {
    await this.lock.serialize(async () => {
      const refused = [...(await this.all()), { ...letter, content: clamp(letter.content) }];
      const value: DeadLetterFile = { refused: refused.slice(-MAX_LETTERS), at: letter.at };
      const target = this.file();
      const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
      await fs.rename(temporary, target);
    });
  }
}

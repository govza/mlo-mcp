import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, WriteChain } from "./atomic-file.js";
import { log } from "../log.js";

/**
 * Ring buffer of timestamped capture outcomes — the gauge source.
 *
 * Gauges, not latches (spec section 6): nothing here is a health verdict that
 * something must later clear. Health is derived per query from the recent
 * window, so a bad observation ages into irrelevance on its own and a healthy
 * capture after a broken one needs no reset ceremony.
 */

export type CaptureOutcome = "ok" | "failed" | "skipped" | "tls-connect-seen";

export interface CaptureEntry {
  at: string;
  outcome: CaptureOutcome;
  detail?: string;
}

export interface CaptureGauge {
  windowMs: number;
  /**
   * idle: nothing observed in the window (MLO has not synced through the
   * proxy — sighting recency, not capture, is the signal for that).
   * degraded: the most recent in-window observation is not an `ok` capture.
   * ok: the most recent in-window observation captured successfully.
   */
  state: "ok" | "degraded" | "idle";
  counts: Record<CaptureOutcome, number>;
  lastAt?: string;
  lastOkAt?: string;
}

export interface CaptureJournal {
  record(outcome: CaptureOutcome, detail?: string): Promise<void>;
  /** Every retained entry, oldest first. */
  entries(): Promise<CaptureEntry[]>;
  /** Health derived from the entries inside the window — never a stored verdict. */
  gauge(windowMs?: number): Promise<CaptureGauge>;
}

interface JournalFile {
  entries: CaptureEntry[];
  at: string;
}

const FILE_NAME = "capture-journal.json";
/** Bounded twice: the ring caps a persistent fault, the window ages out the rest. */
export const DEFAULT_JOURNAL_CAP = 256;
export const DEFAULT_GAUGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class FileCaptureJournal implements CaptureJournal {
  private readonly writes = new WriteChain();

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly cap = DEFAULT_JOURNAL_CAP,
  ) {}

  private file(): string {
    return path.join(this.dir, FILE_NAME);
  }

  private async load(): Promise<CaptureEntry[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), "utf8")) as Partial<JournalFile>;
      return (parsed.entries ?? []).filter((entry) => typeof entry?.at === "string");
    } catch (error) {
      // Absent is the normal case. A corrupt journal is evidence lost, not a
      // fault worth keeping: the next record overwrites it, so degrade to
      // empty loudly rather than wedging every gauge until someone deletes it.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`could not read the capture journal (treated as empty): ${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    }
  }

  record(outcome: CaptureOutcome, detail?: string): Promise<void> {
    return this.writes.run(async () => {
      const at = this.now().toISOString();
      const entries = [...(await this.load()), { at, outcome, ...(detail ? { detail } : {}) }];
      const value: JournalFile = { entries: entries.slice(-this.cap), at };
      await atomicWrite(this.file(), `${JSON.stringify(value, null, 2)}\n`);
    });
  }

  entries(): Promise<CaptureEntry[]> {
    return this.load();
  }

  async gauge(windowMs: number = DEFAULT_GAUGE_WINDOW_MS): Promise<CaptureGauge> {
    return deriveGauge(await this.load(), windowMs, this.now());
  }
}

/** Shared by the file journal and its fake, so the derivation cannot drift. */
export function deriveGauge(entries: CaptureEntry[], windowMs: number, now: Date): CaptureGauge {
  const cutoff = now.getTime() - windowMs;
  const recent = entries.filter((entry) => Date.parse(entry.at) >= cutoff);
  const counts: Record<CaptureOutcome, number> = { ok: 0, failed: 0, skipped: 0, "tls-connect-seen": 0 };
  let lastAt: string | undefined;
  let lastOkAt: string | undefined;
  for (const entry of recent) {
    if (entry.outcome in counts) counts[entry.outcome] += 1;
    lastAt = entry.at;
    if (entry.outcome === "ok") lastOkAt = entry.at;
  }
  const latest = recent.at(-1);
  const state: CaptureGauge["state"] = !latest ? "idle" : latest.outcome === "ok" ? "ok" : "degraded";
  return {
    windowMs,
    state,
    counts,
    ...(lastAt ? { lastAt } : {}),
    ...(lastOkAt ? { lastOkAt } : {}),
  };
}

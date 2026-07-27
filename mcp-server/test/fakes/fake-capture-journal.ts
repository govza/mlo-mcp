import {
  DEFAULT_GAUGE_WINDOW_MS,
  DEFAULT_JOURNAL_CAP,
  deriveGauge,
  type CaptureEntry,
  type CaptureGauge,
  type CaptureJournal,
  type CaptureOutcome,
} from "../../src/cloud/capture-journal.js";

/**
 * In-memory CaptureJournal. Gauge derivation is the REAL derivation
 * (deriveGauge is shared), so a fake-driven gauge test exercises the same
 * aging the file journal does; only persistence is faked away.
 */
export class FakeCaptureJournal implements CaptureJournal {
  private readonly stored: CaptureEntry[] = [];

  constructor(
    private readonly cap = DEFAULT_JOURNAL_CAP,
    public now: () => Date = () => new Date(),
  ) {}

  async record(outcome: CaptureOutcome, detail?: string): Promise<void> {
    this.stored.push({ at: this.now().toISOString(), outcome, ...(detail ? { detail } : {}) });
    if (this.stored.length > this.cap) this.stored.splice(0, this.stored.length - this.cap);
  }

  async entries(): Promise<CaptureEntry[]> {
    return [...this.stored];
  }

  async gauge(windowMs: number = DEFAULT_GAUGE_WINDOW_MS): Promise<CaptureGauge> {
    return deriveGauge(this.stored, windowMs, this.now());
  }
}

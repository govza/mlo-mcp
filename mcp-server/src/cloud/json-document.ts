import { promises as fs } from "node:fs";
import { atomicWrite, WriteChain } from "./atomic-file.js";
import { log } from "../log.js";

/**
 * One durable JSON file: load, read-modify-write under an in-process
 * WriteChain, replace via temp-file rename. The single implementation of the
 * pattern every small partition store repeats — an absent file is the empty
 * value, a corrupt one either throws (durable state that must not be silently
 * dropped) or degrades to empty with a log line (evidence, not a wedge).
 *
 * Single-writer files only (the resident); the cross-process variant is
 * StateRootLock.
 */
export interface JsonDocumentOptions<T> {
  /** Parsed file content -> value. Called only when the file exists and parses. */
  unwrap(parsed: unknown): T;
  /** Value -> the JSON body persisted on save. */
  wrap(value: T): unknown;
  /** The value an absent (or degraded-corrupt) file reads as. */
  empty(): T;
  /** Flush the temp file before the rename — the durable-accept variant. */
  fsync?: boolean;
  /**
   * What a file that exists but cannot be read as JSON means. "throw" for
   * durable state (default); "empty" degrades loudly for bounded evidence
   * rings, where the next record overwrites the corruption anyway.
   */
  onCorrupt?: "throw" | "empty";
  /** Pretty-print with a trailing newline (human-inspected files). */
  pretty?: boolean;
}

export class JsonDocument<T> {
  private readonly writes = new WriteChain();

  constructor(
    private readonly file: string,
    private readonly options: JsonDocumentOptions<T>,
  ) {}

  async read(): Promise<T> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.options.empty();
    }
    try {
      return this.options.unwrap(JSON.parse(raw) as unknown);
    } catch (error) {
      if (this.options.onCorrupt !== "empty") throw error;
      log(`could not read ${this.file} (treated as empty): ${error instanceof Error ? error.message : String(error)}`);
      return this.options.empty();
    }
  }

  /**
   * Serialized read-modify-write: `mutate` sees the current value and returns
   * the next one plus the caller's answer; the save resolves before the answer
   * does, so with `fsync` the answer is only ever given about durable state.
   */
  update<R>(mutate: (value: T) => { value: T; result: R } | Promise<{ value: T; result: R }>): Promise<R> {
    return this.writes.run(async () => {
      const { value, result } = await mutate(await this.read());
      const body = this.options.wrap(value);
      const text = this.options.pretty ? `${JSON.stringify(body, null, 2)}\n` : JSON.stringify(body);
      await atomicWrite(this.file, text, this.options.fsync ? { fsync: true } : undefined);
      return result;
    });
  }
}

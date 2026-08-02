import fs from "node:fs";
import path from "node:path";

/**
 * The mirror exists for one process: the resident endpoint, spawned detached
 * with `stdio: "ignore"`, whose stderr therefore survives nowhere. With a
 * mirror set, every line also lands in a file (under the state root) so a
 * declined auto-init or a failed pull leaves evidence a human can read.
 *
 * Best-effort by contract: logging must never throw, so a mirror that cannot
 * be written is dropped silently rather than becoming the failure it was
 * meant to record. Synchronous appends, deliberately — the resident logs a
 * handful of lines per sync session, and a detached process can exit before
 * an async flush.
 */
let mirrorFile: string | undefined;
/** Running size, so a long-lived resident rotates without a stat per line. */
let mirrorBytes = 0;

/** Rotate rather than grow: one `.old` generation is all the history needed. */
const MIRROR_ROTATE_BYTES = 2 * 1024 * 1024;

function rotate(file: string): void {
  fs.rmSync(`${file}.old`, { force: true });
  fs.renameSync(file, `${file}.old`);
  mirrorBytes = 0;
}

export function mirrorLogToFile(file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    mirrorBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (mirrorBytes > MIRROR_ROTATE_BYTES) rotate(file);
    mirrorFile = file;
  } catch {
    mirrorFile = undefined;
  }
}

/** Tests only: leave no module-level mirror pointed at a deleted temp dir. */
export function stopLogMirror(): void {
  mirrorFile = undefined;
}

/** stderr-only logging — stdout carries the JSON-RPC stream. */
export function log(message: string): void {
  process.stderr.write(`[mlo-mcp] ${message}\n`);
  if (mirrorFile) {
    try {
      const line = `${new Date().toISOString()} ${message}\n`;
      fs.appendFileSync(mirrorFile, line);
      mirrorBytes += Buffer.byteLength(line);
      // The resident is long-lived, so growth between restarts must rotate too.
      if (mirrorBytes > MIRROR_ROTATE_BYTES) rotate(mirrorFile);
    } catch {
      /* an unwritable mirror must never break the caller */
    }
  }
}

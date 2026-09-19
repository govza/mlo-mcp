import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MloConfig } from "../types.js";

/** ERRORLEVEL values documented by mlo.exe -? */
const EXIT_MESSAGES: Record<number, string> = {
  1: "invalid command-line argument",
  2: "target file already exists (mlo.exe -saveXML/-saveML never overwrite)",
  3: "error writing target file",
  100: "unspecified MLO error",
};

export class MloError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number
  ) {
    super(message);
    this.name = "MloError";
  }
}

/**
 * The named driver seam over mlo.exe ([spec section 4](../../../docs/adr/0005-target-architecture-spec.md)):
 * constructor-injected into the MloRepository implementation and invisible to
 * every layer above it.
 */
export interface MloCli {
  /** Export the full task tree to XML and return the XML text. */
  exportXml(): Promise<string>;
  /** Trigger MLO's QuickSync (cloud/Wi-Fi sync as configured in the profile). */
  quickSync(): Promise<void>;
  /**
   * MLO's own throttle state for the deprecated `-QuickSync` switch, read
   * (never written) from its settings. `undefined` when it cannot be read —
   * the caller then falls back to a time-based gate rather than guessing.
   */
  quickSyncThrottle(): Promise<QuickSyncThrottle | undefined>;
  /** Read the raw .ml data file (for GUID extraction). */
  readDataFile(): Promise<Buffer>;
}

/**
 * The process seam inside the driver: spawn mlo.exe with an already-composed
 * argument line and resolve on exit 0. `FakeMloCli` (test/fakes) simulates the
 * app behind this signature, including both live CLI traps.
 */
export type MloExec = (exePath: string, args: string[], timeoutMs: number) => Promise<void>;

/**
 * All mlo.exe invocations are serialized through a single promise-chain
 * mutex: MLO forwards CLI commands to a running instance via IPC, and
 * concurrent invocations interleave unpredictably.
 */
let chain: Promise<unknown> = Promise.resolve();

export function withMloLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  // keep the chain alive even when fn rejects
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Cross-PROCESS lock: several mlo-mcp servers (one per Claude session) can
 * target the same profile, and concurrent mlo.exe invocations fight over the
 * .ml file ("cannot open — used by another process" dialog). A lock directory
 * next to the data file serializes them; mkdir is atomic on NTFS.
 * Reentrant within this process (the promise-chain mutex already serializes us).
 */
let fileLockHeld = false;

/** True while an MLO operation (or the whole write pipeline) is in flight. */
export function isMloBusy(): boolean {
  return fileLockHeld;
}

async function withFileLock<T>(config: MloConfig, fn: () => Promise<T>): Promise<T> {
  if (fileLockHeld) return fn();
  const lockDir = `${config.dataFile}.mcp-lock`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch {
      try {
        const st = await fs.stat(lockDir);
        if (Date.now() - st.mtimeMs > 180_000) {
          await fs.rm(lockDir, { recursive: true, force: true }); // stale (crashed process)
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      if (Date.now() > deadline) {
        throw new MloError(
          `another mlo-mcp process has been using the data file for over 90s (lock: ${lockDir}). ` +
            `If no other session is actually running MLO operations, delete that directory.`
        );
      }
      await sleep(500);
    }
  }
  fileLockHeld = true;
  try {
    return await fn();
  } finally {
    fileLockHeld = false;
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

/** Both locks: in-process serialization + cross-process file lock. */
export function withMloFileLock<T>(config: MloConfig, fn: () => Promise<T>): Promise<T> {
  return withMloLock(() => withFileLock(config, fn));
}

/**
 * Compose an mlo.exe command line, enforcing the two live CLI traps
 * (docs/mlo/mlo-cli.md):
 *
 * 1. **Always pass the explicit data-file path.** A pathless invocation
 *    against an open GUI forwards against the registry's LastDBFile — stale
 *    after an in-app profile switch — and can silently no-op with exit 0.
 * 2. **Only the data file may be positional.** Any other bare argument parses
 *    as `<FileToOpen>` (e.g. a caption after a missing `=`), bypassing
 *    single-instance forwarding and launching a second MLO instance.
 */
export function mloArgs(dataFile: string, flags: string[]): string[] {
  if (!dataFile) {
    throw new MloError("refusing a pathless mlo.exe invocation: it can silently no-op against a stale registry profile");
  }
  for (const flag of flags) {
    if (!flag.startsWith("-")) {
      throw new MloError(
        `refusing mlo.exe argument "${flag}": a bare argument parses as <FileToOpen> and spawns a second MLO instance`
      );
    }
  }
  return [dataFile, ...flags, "-console"];
}

/**
 * mlo.exe is a Delphi app: a literal quote inside a quoted argument must be
 * DOUBLED (""), not backslash-escaped (\") as Node's default Windows escaping
 * does — \" makes MLO misparse the command (it pops a "task not found" dialog
 * and never exits). Build the command line ourselves and pass it verbatim.
 */
function delphiQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

const execMlo: MloExec = (exePath, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(exePath, args.map(delphiQuote), {
      timeout: timeoutMs,
      windowsHide: true,
      killSignal: "SIGKILL",
      windowsVerbatimArguments: true,
      // with verbatim arguments the exe path itself must be quoted in the
      // command line, or its spaces shift every parameter the child sees
      argv0: delphiQuote(exePath),
      stdio: "ignore",
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new MloError(`mlo.exe not found at "${exePath}". Set MLO_EXE_PATH to the correct location.`));
      } else {
        reject(new MloError(`failed to run mlo.exe: ${err.message}`));
      }
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(
          new MloError(
            `mlo.exe did not finish within ${timeoutMs / 1000}s and was killed. ` +
              `This happens when MLO opens a modal dialog (e.g. an invalid -task GUID while the GUI is running).`
          )
        );
      } else if (code === 0) {
        resolve();
      } else {
        const detail = EXIT_MESSAGES[code ?? -1] ?? "unknown exit code";
        reject(new MloError(`mlo.exe exited with code ${code}: ${detail}`, code ?? undefined));
      }
    });
  });

/**
 * MLO's client-side guard on the deprecated `-QuickSync` switch, as its
 * settings record it: how many invocations the current window has seen, and
 * when the last one ran. Measured against 6.1.3 (2026-08-12, 2026-09-19): the
 * stamp moves on every invocation, so the window slides from the LAST one;
 * an invocation past the window resets the counter to 0 and runs; one inside
 * the window that would take the counter to 5 pops the throttle modal, hangs
 * the CLI and runs no session at all.
 */
export interface QuickSyncThrottle {
  count: number;
  /** Epoch ms of the last invocation; absent when the stamp could not be decoded. */
  lastInvokedAt?: number;
}

export type QuickSyncVerdict = { affordable: true } | { affordable: false; retryAfterMs: number };

/**
 * Whether one more `-QuickSync` stays under MLO's guard. The counter alone
 * would freeze the nudge for good once it reaches the budget, because MLO
 * only resets it on the next invocation — so a spent budget is affordable
 * again once the window has slid past the last invocation.
 */
export function quickSyncVerdict(
  throttle: QuickSyncThrottle,
  budget: { maxPerWindow: number; windowMs: number },
  now = Date.now()
): QuickSyncVerdict {
  if (throttle.count < budget.maxPerWindow) return { affordable: true };
  if (throttle.lastInvokedAt === undefined) return { affordable: false, retryAfterMs: budget.windowMs };
  const remaining = throttle.lastInvokedAt + budget.windowMs - now;
  return remaining <= 0 ? { affordable: true } : { affordable: false, retryAfterMs: remaining };
}

/**
 * Read-only: the state is MLO's, and forging it would defeat a guard the
 * vendor put there on purpose.
 */
const QUICKSYNC_KEY = "HKCU\\Software\\MyLifeOrganized.net\\MyLife\\Settings";

/** A Delphi TDateTime: days since 1899-12-30, in local wall-clock time. */
const DELPHI_EPOCH_MS = Date.UTC(1899, 11, 30);

export function delphiDateTimeToEpochMs(hex: string, now = new Date()): number | undefined {
  if (!/^[0-9a-f]{16}$/i.test(hex)) return undefined;
  const days = Buffer.from(hex, "hex").readDoubleLE(0);
  if (!Number.isFinite(days)) return undefined;
  return DELPHI_EPOCH_MS + days * 86_400_000 + now.getTimezoneOffset() * 60_000;
}

/** Parses `reg query` output for the settings key; `undefined` when the counter is absent. */
export function parseQuickSyncThrottle(out: string, now = new Date()): QuickSyncThrottle | undefined {
  // "    QuickSyncCount    REG_DWORD    0x4"
  const count = /QuickSyncCount\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(out);
  if (!count) return undefined;
  const parsed = Number(count[1]);
  if (!Number.isFinite(parsed)) return undefined;
  // "    QuickSyncTime    REG_BINARY    945853F68199E640"
  const stamp = /QuickSyncTime\s+REG_BINARY\s+([0-9a-f]+)/i.exec(out);
  const lastInvokedAt = stamp ? delphiDateTimeToEpochMs(stamp[1]!, now) : undefined;
  return lastInvokedAt === undefined ? { count: parsed } : { count: parsed, lastInvokedAt };
}

/**
 * Best-effort: any failure (not Windows, key absent, `reg.exe` missing, output
 * in a shape we do not recognise) answers `undefined`, never a throw. The
 * nudge is an accelerator — it may never become a source of refusals.
 */
function readQuickSyncThrottle(): Promise<QuickSyncThrottle | undefined> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("reg.exe", ["query", QUICKSYNC_KEY], {
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(undefined));
    child.on("exit", (code) => resolve(code === 0 ? parseQuickSyncThrottle(out) : undefined));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let exportCounter = 0;

/** The real driver: spawns mlo.exe. The locks and the export counter stay module-level — process-wide serialization is the point. */
export class SystemMloCli implements MloCli {
  constructor(
    private readonly config: MloConfig,
    private readonly exec: MloExec = execMlo
  ) {}

  private async ensureDataFile(): Promise<void> {
    try {
      await fs.access(this.config.dataFile);
    } catch {
      throw new MloError(`MLO data file not found at "${this.config.dataFile}"`);
    }
  }

  exportXml(): Promise<string> {
    return withMloFileLock(this.config, async () => {
      await this.ensureDataFile();
      await fs.mkdir(this.config.exportDir, { recursive: true });
      const target = path.join(this.config.exportDir, `export-${process.pid}-${++exportCounter}.xml`);
      await fs.rm(target, { force: true });
      try {
        await this.exec(this.config.mloExePath, mloArgs(this.config.dataFile, [`-saveXML=${target}`]), 30_000);
        return await fs.readFile(target, "utf8");
      } finally {
        await fs.rm(target, { force: true });
      }
    });
  }

  quickSync(): Promise<void> {
    return withMloFileLock(this.config, async () => {
      await this.ensureDataFile();
      // A healthy invocation forwards to the running app and exits in ~13 s
      // (measured). The long tail is the throttle modal, which hangs the CLI
      // outright — and this lock is process-wide, so every export waits behind
      // it. Bound the hold: a nudge is never worth stalling reads for minutes.
      await this.exec(this.config.mloExePath, mloArgs(this.config.dataFile, ["-QuickSync"]), 30_000);
    });
  }

  async quickSyncThrottle(): Promise<QuickSyncThrottle | undefined> {
    return readQuickSyncThrottle();
  }

  readDataFile(): Promise<Buffer> {
    return fs.readFile(this.config.dataFile);
  }
}

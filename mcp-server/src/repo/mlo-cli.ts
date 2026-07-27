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
      await this.exec(this.config.mloExePath, mloArgs(this.config.dataFile, ["-QuickSync"]), 120_000);
    });
  }

  readDataFile(): Promise<Buffer> {
    return fs.readFile(this.config.dataFile);
  }
}

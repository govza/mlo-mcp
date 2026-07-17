import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MloConfig } from "./types.js";

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
 * mlo.exe is a Delphi app: a literal quote inside a quoted argument must be
 * DOUBLED (""), not backslash-escaped (\") as Node's default Windows escaping
 * does — \" makes MLO misparse the command (it pops a "task not found" dialog
 * and never exits). Build the command line ourselves and pass it verbatim.
 */
function delphiQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

function execMlo(config: MloConfig, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.mloExePath, [...args, "-console"].map(delphiQuote), {
      timeout: timeoutMs,
      windowsHide: true,
      killSignal: "SIGKILL",
      windowsVerbatimArguments: true,
      // with verbatim arguments the exe path itself must be quoted in the
      // command line, or its spaces shift every parameter the child sees
      argv0: delphiQuote(config.mloExePath),
      stdio: "ignore",
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new MloError(`mlo.exe not found at "${config.mloExePath}". Set MLO_EXE_PATH to the correct location.`));
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
}

/** True when any mlo.exe process is running (assumed to be the GUI holding the data file). */
export function isMloRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", "IMAGENAME eq mlo.exe", "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(!error && stdout.toLowerCase().includes("mlo.exe"))
    );
  });
}

async function ensureDataFile(config: MloConfig): Promise<void> {
  try {
    await fs.access(config.dataFile);
  } catch {
    throw new MloError(`MLO_DATA_FILE not found at "${config.dataFile}"`);
  }
}

let exportCounter = 0;

/**
 * Export the task tree to XML and return the XML text.
 * When `taskGuid` is given, only that subtree is exported (mlo.exe -task=… -saveXML=…).
 * WARNING: never pass `taskGuid` while the MLO GUI is running — it zooms the user's view.
 */
export function exportXml(config: MloConfig, taskGuid?: string): Promise<string> {
  return withMloLock(async () => {
    await ensureDataFile(config);
    await fs.mkdir(config.exportDir, { recursive: true });
    const target = path.join(config.exportDir, `export-${process.pid}-${++exportCounter}.xml`);
    await fs.rm(target, { force: true });
    const args = [config.dataFile];
    if (taskGuid) args.push(`-task=${taskGuid}`);
    args.push(`-saveXML=${target}`);
    try {
      await execMlo(config, args, 30_000);
      return await fs.readFile(target, "utf8");
    } finally {
      await fs.rm(target, { force: true });
    }
  });
}

export interface AddTaskOptions {
  /** GUID of the parent task ({xxxxxxxx-…}); the new task becomes its subtask. */
  parentGuid?: string;
  /** Run the caption through MLO's input parser (-Parse): dates, @contexts, -i/-u switches… */
  parse?: boolean;
}

/** Add a task via mlo.exe -AddSubtask. Returns nothing; re-export to see the result. */
export function addTask(config: MloConfig, caption: string, options: AddTaskOptions = {}): Promise<void> {
  return withMloLock(async () => {
    await ensureDataFile(config);
    const args = [config.dataFile];
    if (options.parentGuid) args.push(`-task=${options.parentGuid}`);
    args.push(`-AddSubtask=${caption}`);
    if (options.parse) args.push("-Parse");
    await execMlo(config, args, 30_000);
  });
}

/** Trigger MLO's QuickSync (cloud/Wi-Fi sync as configured in the profile). */
export function quickSync(config: MloConfig): Promise<void> {
  return withMloLock(async () => {
    await ensureDataFile(config);
    await execMlo(config, [config.dataFile, "-QuickSync"], 120_000);
  });
}

/**
 * Convert an XML export back into a .ml data file (mlo.exe <xml> -saveML=<ml>).
 * The target must not exist; it is pre-deleted here.
 */
export function convertXmlToMl(config: MloConfig, xmlPath: string, mlPath: string): Promise<void> {
  return withMloLock(async () => {
    await fs.rm(mlPath, { force: true });
    await execMlo(config, [xmlPath, `-saveML=${mlPath}`], 30_000);
  });
}

/** Read the raw .ml data file (for GUID extraction). */
export function readDataFile(config: MloConfig): Promise<Buffer> {
  return fs.readFile(config.dataFile);
}

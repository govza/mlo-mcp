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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gracefully close the MLO GUI (taskkill without /F posts WM_CLOSE — the same
 * as clicking X, so MLO saves its data on the way out). Fails when a modal
 * dialog is blocking the app.
 */
export async function closeMloGui(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/IM", "mlo.exe"], { windowsHide: true, timeout: 10_000 }, () => resolve());
    });
    for (let i = 0; i < 10; i++) {
      await sleep(700);
      if (!(await isMloRunning())) return;
    }
  }
  throw new MloError(
    "could not close the MyLifeOrganized app — a dialog may be blocking it. " +
      "Close MLO manually (including any popup) and retry."
  );
}

/**
 * Relaunch the MLO GUI detached on the given data file (no -console: it must
 * stay open) and wait until it has finished loading. Returning before the GUI
 * owns the file is dangerous: the next CLI invocation would race it for the
 * .ml file and MLO pops a "file is locked by another process" dialog.
 */
export async function launchMloGui(config: MloConfig): Promise<void> {
  if (config.relaunchStyle === "minimized") {
    // Launch through `start /min`: the SW_SHOWMINIMIZED startup hint keeps the
    // window out of the user's face and does not steal focus. (Node cannot set
    // STARTUPINFO.wShowWindow itself.) The empty "" is start's window title slot.
    const child = spawn("cmd.exe", ["/c", "start", '""', "/min", delphiQuote(config.mloExePath), delphiQuote(config.dataFile)], {
      windowsVerbatimArguments: true,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } else {
    const child = spawn(config.mloExePath, [delphiQuote(config.dataFile)], {
      windowsVerbatimArguments: true,
      argv0: delphiQuote(config.mloExePath),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // ready = a "...MyLifeOrganized" window title exists, OR MLO holds the data
  // file (a minimized-to-tray window has no title, so probe the file lock too).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(800);
    const titleReady = await new Promise<boolean>((resolve) => {
      execFile(
        "tasklist",
        ["/V", "/FO", "CSV", "/NH", "/FI", "IMAGENAME eq mlo.exe"],
        { windowsHide: true, timeout: 10_000 },
        (error, stdout) => resolve(!error && stdout.includes("MyLifeOrganized"))
      );
    });
    if (titleReady || (await isDataFileLocked(config))) break;
  }
  await sleep(1500); // settle: let it finish acquiring file handles
}

/** True when another process (the MLO GUI) holds the data file open. */
async function isDataFileLocked(config: MloConfig): Promise<boolean> {
  try {
    const handle = await fs.open(config.dataFile, "r+");
    await handle.close();
    return false;
  } catch {
    return true;
  }
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
  return withMloFileLock(config, () => exportXmlUnlocked(config, taskGuid));
}

/** Lock-free variant for callers (write pipeline) that already hold both locks. */
export async function exportXmlUnlocked(config: MloConfig, taskGuid?: string): Promise<string> {
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
}

export interface AddTaskOptions {
  /** GUID of the parent task ({xxxxxxxx-…}); the new task becomes its subtask. */
  parentGuid?: string;
  /** Run the caption through MLO's input parser (-Parse): dates, @contexts, -i/-u switches… */
  parse?: boolean;
}

/** Add a task via mlo.exe -AddSubtask. Returns nothing; re-export to see the result. */
export function addTask(config: MloConfig, caption: string, options: AddTaskOptions = {}): Promise<void> {
  return withMloFileLock(config, async () => {
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
  return withMloFileLock(config, async () => {
    await ensureDataFile(config);
    await execMlo(config, [config.dataFile, "-QuickSync"], 120_000);
  });
}

/**
 * Convert an XML export back into a .ml data file (mlo.exe <xml> -saveML=<ml>).
 * The target must not exist; it is pre-deleted here.
 */
export function convertXmlToMl(config: MloConfig, xmlPath: string, mlPath: string): Promise<void> {
  return withMloFileLock(config, () => convertXmlToMlUnlocked(config, xmlPath, mlPath));
}

/** Lock-free variant for callers (write pipeline) that already hold both locks. */
export async function convertXmlToMlUnlocked(config: MloConfig, xmlPath: string, mlPath: string): Promise<void> {
  await fs.rm(mlPath, { force: true });
  await execMlo(config, [xmlPath, `-saveML=${mlPath}`], 30_000);
}

/** Read the raw .ml data file (for GUID extraction). */
export function readDataFile(config: MloConfig): Promise<Buffer> {
  return fs.readFile(config.dataFile);
}

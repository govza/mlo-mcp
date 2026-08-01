import path from "node:path";
import { execFile, spawnSync } from "node:child_process";

/**
 * Which profile does MLO actually have open?
 *
 * **Only the running app is asked.** Nothing MLO saved for next time is
 * consulted — not `LastDBFile`, not the MRU list — because a saved value
 * describes a session that has ended
 * ([ADR-0006](../../docs/adr/0006-detect-the-open-profile-from-the-process-alone.md)).
 * `LastDBFile` in particular is written when MLO *exits*, so it is stale after
 * an in-app switch and empty on an install that has never exited cleanly, which
 * is a refusal to start on a machine with a profile plainly open.
 *
 * The running process states the answer itself, in its own log. MLO writes one
 * session block per run, tagged with that run's pid, and records every profile
 * it opens in it:
 *
 * ```text
 * 01/08/2026 [008744] 15:24:18.468      --- Log started Ver. 6.1.3
 * 01/08/2026 [008744] 15:38:13.654      New data file created
 * 01/08/2026 [008744] 15:38:27.593      Save as: D:\dev\demo\demo.ml
 * ```
 *
 * So detection is: find the running `mlo.exe`, read its own session block, and
 * take the last profile it says it opened. The pid tag is what makes this the
 * *process's* statement rather than a leftover — a block belongs to one run, and
 * a run that has not recorded an open has no profile to report.
 *
 * Two further signals from the same process corroborate the answer, and each is
 * used only for what it can prove:
 *
 * - **Window title** — MLO titles its main window `<name>.ml - MyLifeOrganized`,
 *   naming the open profile (file name only, and only while a window exists — it
 *   is empty when MLO sits in the tray).
 * - **Exclusive open** — MLO holds the open profile's file for the whole
 *   session, so a file nobody holds is a file MLO does not have open.
 *
 * An *unavailable* signal never refutes; a *contradicting* one refuses rather
 * than substituting a guess.
 */

/** One running `mlo.exe`, as the OS reports it. */
export interface RunningApp {
  pid: number;
  /** Main-window title; empty while MLO sits in the tray. */
  windowTitle: string;
}

/** Whether the resolved profile file is open in another process right now. */
export type FileState = "held" | "free" | "missing";

export interface ProfileObservation {
  /** Every running `mlo.exe`. Empty when MLO is not running. */
  apps: RunningApp[];
  /** MLO's own log was found and read. False when logging is off or it is unreadable. */
  logRead: boolean;
  /** Profile-bearing lines of that log, oldest first, narrowed to the running pids. */
  lines: string[];
  /** Keyed by the path as the log spells it; a path absent from it was not tested. */
  held: Record<string, FileState>;
}

/**
 * Refusals, split by what the *watcher* must do with them, not by cause:
 *
 * - `profile-not-open` / `profile-contradicted` are definite — the running app
 *   does not have a usable profile open, or does not have ours. A live session
 *   exits.
 * - `profile-undetectable` means we could not tell. It is transient by nature
 *   (the probe failed, the log was unreadable or had rotated), so it must never
 *   cycle a working session.
 *
 * These are the `startup-verdict` kinds of the error contract; their meanings
 * and standing remedies live in `error-contract.ts` with every other kind.
 */
export type ProfileRefusal = "profile-not-open" | "profile-contradicted" | "profile-undetectable";

export type ProfileVerdict =
  | { ok: true; dataFile: string }
  | { ok: false; reason: ProfileRefusal; message: string };

/**
 * `2022.ml - MyLifeOrganized` → `2022.ml`. Greedy up to the last separator, so
 * a profile whose own name contains " - " survives; anchored on a following
 * non-space so an untitled or non-profile window yields nothing.
 */
const TITLED_PROFILE = /^\s*\*?\s*(.*\.ml)\s+-\s+\S/i;

/** File names of the profiles MLO's own windows report having open. */
export function openProfileNames(windowTitles: string[]): string[] {
  return windowTitles.flatMap((title) => {
    const named = TITLED_PROFILE.exec(title);
    if (!named) return [];
    // win32 explicitly: a path in a Windows window title stays a Windows path
    // however this code is being tested.
    return [path.win32.basename(named[1])];
  });
}

/**
 * A log line that bears on which profile a run has open. Everything else in
 * MLO's log (dpi traces, sync errors, localized status messages) is noise here.
 */
export interface LogEvent {
  pid: number;
  /** `started` opens a run's block; `opened` names a profile; `unsaved` leaves it with none. */
  kind: "started" | "opened" | "unsaved";
  /** Present on `opened` only. */
  file?: string;
}

/** `01/08/2026 [008744] 15:38:27.593      Save as: D:\dev\demo\demo.ml` */
const LOG_LINE = /^\d\S*\s+\[(\d+)\]\s+\d[\d:.]*\s+(.*)$/;
const SESSION_START = /^---\s*Log started\b/i;
// Both verbs leave the named file as the run's open profile: "Save as" switches
// MLO to the new file (that is what the title bar then shows), it does not copy.
const OPENED_FILE = /^(?:Opening datafile|Save as):\s*(.+?)\s*$/i;
// A never-saved outline. It leaves the run with no file at all, so it CLEARS a
// previously opened path rather than being ignored.
const NEW_FILE = /^New data file created\b/i;

/** The profile-bearing events of MLO's log, in the order it wrote them. */
export function parseLogEvents(lines: readonly string[]): LogEvent[] {
  return lines.flatMap((line): LogEvent[] => {
    const matched = LOG_LINE.exec(line);
    if (!matched) return [];
    const pid = Number(matched[1]);
    const message = matched[2];
    if (SESSION_START.test(message)) return [{ pid, kind: "started" }];
    if (NEW_FILE.test(message)) return [{ pid, kind: "unsaved" }];
    const opened = OPENED_FILE.exec(message);
    return opened ? [{ pid, kind: "opened", file: opened[1] }] : [];
  });
}

export type RunProfile =
  | { kind: "profile"; dataFile: string }
  /** The run has an outline open that has never been saved, so there is no `.ml`. */
  | { kind: "unsaved" }
  /** The log holds no session block for this run — it cannot speak for it. */
  | { kind: "unknown" };

/**
 * What one running process says it has open.
 *
 * Scoped to the run's *last* session block, because Windows recycles pids: an
 * older MLO run in the same log could carry this pid and name a profile that
 * has nothing to do with the live one. Within the block the last event wins —
 * an in-app switch appends a new `Opening datafile`, which is exactly how the
 * answer follows the app instead of going stale.
 */
export function resolveRun(pid: number, events: readonly LogEvent[]): RunProfile {
  const mine = events.filter((event) => event.pid === pid);
  const started = mine.map((event) => event.kind).lastIndexOf("started");
  if (started < 0) return { kind: "unknown" };
  let open: string | undefined;
  let unsaved = false;
  for (const event of mine.slice(started + 1)) {
    if (event.kind === "opened" && event.file) {
      open = event.file;
      unsaved = false;
    } else if (event.kind === "unsaved") {
      open = undefined;
      unsaved = true;
    }
  }
  if (open) return { kind: "profile", dataFile: open };
  return unsaved ? { kind: "unsaved" } : { kind: "unknown" };
}

// Reached when PowerShell cannot be run, the probe times out, or its output does
// not match the contract in parseObservation — including on any non-Windows
// platform, where there is no MLO to detect. Nothing the user does in MLO fixes
// it, so it must not advise doing anything there.
const PROBE_FAILED =
  "Could not detect which profile MLO has open: the detection probe did not return a usable result. " +
  "It needs Windows and powershell.exe. Check the server's stderr log for the probe's own output.";

const NOT_RUNNING =
  "No MLO profile: MLO is not running. The running app is the only thing that knows which profile is " +
  "open — nothing it saved for next time is used, because that describes a session that has ended. " +
  "Start MLO (it reopens your profile itself), then retry.";

const NO_LOG =
  "Could not detect which profile MLO has open: MLO's own log could not be read. That log is where a " +
  "running MLO records the profile it opened, and it is enabled by default — re-enable logging in MLO's " +
  "options if it was turned off, reopen your profile, then retry.";

const NO_SESSION =
  "Could not detect which profile MLO has open: MLO's log carries no session for the running app. Its log " +
  "had most likely rotated by the time this run opened its profile. Reopen the profile in MLO (File → " +
  "Open Recent) so the running app records it, then retry.";

const UNSAVED =
  "MLO has a new outline open that has never been saved, so there is no data file to operate on. " +
  "Save it in MLO, then retry.";

function ambiguousMessage(profiles: string[]): string {
  return (
    `${profiles.length} MLO instances are running with different profiles open:\n` +
    profiles.map((p) => `  ${p}`).join("\n") +
    `\n"the profile MLO has open" has no single answer while that is true, and guessing one would read the ` +
    `wrong task tree and ride the wrong profile's sync. Close all but the instance you are working in, then retry.`
  );
}

function disagreementMessage(dataFile: string, detail: string): string {
  return (
    `MLO's own signals disagree about which profile it has open.\n` +
    `  its log says it opened: ${dataFile}\n` +
    `  ${detail}\n` +
    `Refusing to start rather than operating on a profile you may not be using: reads would return the wrong ` +
    `task tree and writes would ride the wrong profile's sync.\n` +
    `Reopen the profile you want to work in from MLO, then retry.`
  );
}

function refuse(reason: ProfileRefusal, message: string): ProfileVerdict {
  return { ok: false, reason, message };
}

/** Case-insensitively, because the log and the probe spell the same path independently. */
function stateOf(held: Record<string, FileState>, dataFile: string): FileState | undefined {
  const wanted = dataFile.toLowerCase();
  return Object.entries(held).find(([file]) => file.toLowerCase() === wanted)?.[1];
}

/** The whole policy, as a pure function of one observation. */
export function judgeProfile(observed: ProfileObservation | undefined): ProfileVerdict {
  if (!observed) return refuse("profile-undetectable", PROBE_FAILED);
  if (!observed.apps.length) return refuse("profile-not-open", NOT_RUNNING);
  if (!observed.logRead) return refuse("profile-undetectable", NO_LOG);

  const events = parseLogEvents(observed.lines);
  const runs = observed.apps.map((app) => resolveRun(app.pid, events));
  // Distinct paths, not distinct runs: MLO's own single-instance handoff means a
  // second launch appears briefly as a second process, and several windows onto
  // one profile are not a disagreement.
  const open = new Map<string, string>();
  for (const run of runs) if (run.kind === "profile") open.set(run.dataFile.toLowerCase(), run.dataFile);
  const profiles = [...open.values()];
  if (profiles.length > 1) return refuse("profile-contradicted", ambiguousMessage(profiles));
  if (!profiles.length) {
    return runs.some((run) => run.kind === "unsaved")
      ? refuse("profile-not-open", UNSAVED)
      : refuse("profile-undetectable", NO_SESSION);
  }
  const dataFile = profiles[0]!;

  const titles = openProfileNames(observed.apps.map((app) => app.windowTitle));
  const wanted = path.win32.basename(dataFile).toLowerCase();
  if (titles.length && !titles.some((name) => name.toLowerCase() === wanted)) {
    const named = titles.map((name) => `"${name}"`).join(", ");
    return refuse("profile-contradicted", disagreementMessage(dataFile, `its window titles name: ${named}`));
  }
  // Only a definite negative refutes; a path the probe could not test leaves the
  // log's answer standing.
  const state = stateOf(observed.held, dataFile);
  if (state === "missing") {
    return refuse("profile-contradicted", disagreementMessage(dataFile, "that file no longer exists on disk"));
  }
  if (state === "free") {
    return refuse(
      "profile-contradicted",
      disagreementMessage(dataFile, "no process holds that file open, and MLO holds its open profile all session")
    );
  }
  return { ok: true, dataFile };
}

/** Where MLO keeps the log, per install layout. */
const LOG_LEAF = "MyLifeOrganized\\Logs\\mlo_log.txt";

/**
 * How much of the tail to read. MLO rotates the log at ~30 MB, and a session
 * block is a few hundred lines, so this reaches back over many runs while
 * keeping the read (and the JSON that comes back) bounded on a startup path.
 */
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

/** Doubled for a single-quoted PowerShell literal. */
function psQuote(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * One PowerShell round trip for the whole observation — the running processes
 * and their titles, their own lines out of MLO's log, and the exclusive-open
 * test on every profile those lines name.
 *
 * PowerShell rather than reg.exe/Node because the log must be decoded as UTF-8
 * (profile paths are not ASCII everywhere) and because Node cannot make the
 * exclusive-open test itself: libuv only asks for a deny-all share mode via
 * `O_EXLOCK`, which Node does not define on Windows.
 *
 * It **collects only**. It never decides which line wins — that is `judgeProfile`,
 * which stays a pure function over what comes back. The one place the script
 * reads a path itself is to know what to lock-test, and a path its cruder regex
 * misses simply comes back untested, which never refutes.
 */
export function probeScript(mloExePath: string): string {
  const name = psQuote(processNameFor(mloExePath));
  const portableLog = psQuote(path.win32.join(path.win32.dirname(mloExePath), "Logs", "mlo_log.txt"));
  return [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$ErrorActionPreference='SilentlyContinue'",
    // Filtered enumeration, not -Name: -Name takes wildcards, and an exe named
    // with a bracket or star would silently match unrelated processes.
    `$procs=@(Get-Process | Where-Object { $_.ProcessName -ieq '${name}' })`,
    "$apps=@($procs | ForEach-Object { [pscustomobject]@{ pid=$_.Id; windowTitle=$_.MainWindowTitle } })",
    "$logRead=$false; $lines=@(); $held=@{}",
    // No processes, no session block worth reading: the verdict is already fixed.
    "if ($procs.Count -gt 0) {",
    "  $paths=@()",
    `  if ($env:LOCALAPPDATA) { $paths+=(Join-Path $env:LOCALAPPDATA '${psQuote(LOG_LEAF)}') }`,
    `  $paths+='${portableLog}'`,
    "  $log=@($paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })[0]",
    "  if ($log) {",
    // Shared read: MLO is appending to this file the whole time.
    "    try {",
    "      $fs=[System.IO.File]::Open($log,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read," +
      "[System.IO.FileShare]::ReadWrite)",
    `      if ($fs.Length -gt ${LOG_TAIL_BYTES}) { [void]$fs.Seek(-${LOG_TAIL_BYTES},[System.IO.SeekOrigin]::End) }`,
    "      $sr=New-Object System.IO.StreamReader($fs,[System.Text.Encoding]::UTF8)",
    "      $text=$sr.ReadToEnd(); $sr.Dispose(); $fs.Dispose(); $logRead=$true",
    // Narrowed to the live pids here so the lock test below never touches a file
    // belonging to some long-finished run.
    "      $mine='\\[0*(' + ((@($procs | ForEach-Object { $_.Id })) -join '|') + ')\\]'",
    "      $marks='(--- Log started|Opening datafile:|Save as:|New data file created)'",
    "      $lines=@($text -split \"`r?`n\" | Where-Object { $_ -match $mine -and $_ -match $marks } |" +
      " Select-Object -Last 200)",
    "      foreach ($p in @($lines | ForEach-Object {" +
      " if ($_ -match '(?:Opening datafile|Save as):\\s*(.+?)\\s*$') { $Matches[1] } } | Select-Object -Unique)) {",
    "        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $held[$p]='missing'; continue }",
    // FileAccess::Read so a read-only profile is not mistaken for a held one;
    // FileShare::None so the open fails precisely when someone else holds it.
    "        try { $h=[System.IO.File]::Open($p,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read," +
      "[System.IO.FileShare]::None); $h.Close(); $held[$p]='free' } catch { $held[$p]='held' }",
    "      }",
    "    } catch { }",
    "  }",
    "}",
    "[pscustomobject]@{ apps=$apps; logRead=$logRead; lines=$lines; held=$held } | ConvertTo-Json -Compress -Depth 5",
  ].join("\n");
}

function psArgs(mloExePath: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", probeScript(mloExePath)];
}

/** Every key the probe script is contracted to emit, present even when empty. */
export const PROBE_FIELDS = ["apps", "logRead", "lines", "held"] as const;

/** ConvertTo-Json renders a one-element array as a bare scalar. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

const FILE_STATES: readonly string[] = ["held", "free", "missing"];

/**
 * Tolerant of everything PowerShell does to a *value* on the way out — a lone
 * array element collapsed to a scalar, an empty result as null — but strict
 * about the *keys*. `ConvertTo-Json` emits every property of the pscustomobject,
 * so a missing key means the script and this parser have drifted apart. Coercing
 * that to "no signal available" would silently disarm detection (the permissive
 * direction); failing the parse instead surfaces it as a refusal to start.
 */
export function parseObservation(stdout: string): ProfileObservation | undefined {
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text.startsWith("{")) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!PROBE_FIELDS.every((field) => field in raw)) return undefined;
  const apps = asArray(raw.apps).flatMap((app) => {
    if (typeof app !== "object" || app === null) return [];
    const { pid, windowTitle } = app as { pid?: unknown; windowTitle?: unknown };
    if (typeof pid !== "number" || !Number.isInteger(pid)) return [];
    return [{ pid, windowTitle: typeof windowTitle === "string" ? windowTitle : "" }];
  });
  const held: Record<string, FileState> = {};
  if (typeof raw.held === "object" && raw.held !== null) {
    for (const [file, state] of Object.entries(raw.held as Record<string, unknown>)) {
      if (typeof state === "string" && FILE_STATES.includes(state)) held[file] = state as FileState;
    }
  }
  return {
    apps,
    logRead: raw.logRead === true,
    lines: asArray(raw.lines).filter((line): line is string => typeof line === "string"),
    held,
  };
}

/**
 * mlo.exe → "mlo": the process to look for, honoring an MLO_EXE_PATH override.
 *
 * The extension strip must be case-insensitive, which `basename(p, ".exe")` is
 * not: it would leave "MLO.EXE" intact, match no process (Windows reports
 * process names without the extension), and report MLO as not running — which
 * is now a refusal to start on a perfectly healthy machine.
 */
export function processNameFor(mloExePath: string): string {
  return path.win32.basename(mloExePath).replace(/\.exe$/i, "");
}

const PROBE_TIMEOUT_MS = 10_000;

/** undefined when the probe could not be run or its output was unusable. */
export function probeProfileSync(mloExePath: string): ProfileObservation | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("powershell.exe", psArgs(mloExePath), {
    encoding: "utf8",
    windowsHide: true,
    timeout: PROBE_TIMEOUT_MS,
    // The log tail comes back as JSON; the default 1 MB pipe cap would truncate
    // it into unparseable output on a busy install.
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout ? parseObservation(result.stdout) : undefined;
}

function probeProfile(mloExePath: string): Promise<ProfileObservation | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      psArgs(mloExePath),
      { encoding: "utf8", windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (_err, stdout) => resolve(stdout ? parseObservation(stdout) : undefined)
    );
  });
}

/** Non-blocking variant for the periodic profile-switch watcher in index.ts. */
export function detectProfileSync(mloExePath: string): ProfileVerdict {
  return judgeProfile(probeProfileSync(mloExePath));
}

export async function detectProfile(mloExePath: string): Promise<ProfileVerdict> {
  return judgeProfile(await probeProfile(mloExePath));
}

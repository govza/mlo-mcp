import path from "node:path";
import { execFile, spawnSync } from "node:child_process";

/**
 * Which profile does MLO actually have open?
 *
 * The registry's `LastDBFile` alone cannot answer that. MLO writes it when it
 * *exits*, not when it opens a profile, so after an in-app profile switch the
 * value names a profile the app no longer has open — and a server that trusts
 * it reads the wrong tree and rides the wrong sync without any error
 * ([ADR-0004](../../docs/adr/0004-ground-truth-the-open-profile.md)).
 *
 * So the registry value is treated as a *candidate* and checked against the
 * running app, which is the only authority on what it has open. Two signals
 * can refute the candidate; neither can be manufactured from the registry:
 *
 * - **Window title** — MLO titles its main window `<name>.ml - MyLifeOrganized`,
 *   naming the open profile (but only its file name, and only while the window
 *   exists — it is empty when MLO sits in the tray).
 * - **Exclusive open** — MLO holds the open profile's file for the whole
 *   session, so a file nobody holds is a file MLO does not have open. This
 *   distinguishes same-named profiles in different directories, which the
 *   title cannot.
 *
 * Neither signal can *discover* an unrecorded path (the title has no
 * directory, and there is no MLO-maintained recent-profiles list on disk to
 * search), so a refuted candidate is a refusal to start, not a silent
 * substitution.
 */
export interface ProfileObservation {
  /** `HKCU\Software\MyLifeOrganized.net\MyLife\Settings\LastDBFile`; undefined when unset. */
  lastDbFile?: string;
  lastDbFileExists: boolean;
  /** An mlo.exe process is running, so there is an open profile to disagree with. */
  appRunning: boolean;
  /** Raw main-window titles of every mlo.exe; empty while MLO sits in the tray. */
  windowTitles: string[];
  /** Another process holds `lastDbFile` open; undefined when it could not be tested. */
  lastDbFileHeldByOther?: boolean;
}

export type ProfileVerdict =
  | { ok: true; dataFile: string }
  | { ok: false; reason: "no-profile" | "profile-switched"; message: string };

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

const NO_PROFILE_AT_ALL =
  "No MLO profile found: MLO's settings record no last-opened profile. " +
  "Open your profile in MLO once so the server can detect it.";

// Distinct from the two "MLO told us nothing" refusals: nothing the user does in
// MLO fixes this one, so it must not advise opening a profile. Reached when
// PowerShell cannot be run, the probe times out, or its output does not match
// the contract in parseObservation — including on any non-Windows platform,
// where there is no MLO to detect.
const PROBE_FAILED =
  "Could not detect which profile MLO has open: the detection probe did not return a usable result. " +
  "It needs Windows and powershell.exe. Check the server's stderr log for the probe's own output.";

function switchedMessage(candidate: string, openNames: string[]): string {
  const actual = openNames.length
    ? openNames.map((n) => `"${n}"`).join(", ")
    : "another profile (it does not hold this file open)";
  return (
    `MLO has a different profile open than its own settings record.\n` +
    `  settings (LastDBFile): ${candidate}\n` +
    `  MLO actually has open: ${actual}\n` +
    `MLO writes LastDBFile only when it exits, so the value goes stale after an in-app profile switch. ` +
    `Refusing to start rather than operating on a profile you are not using: reads would return the wrong ` +
    `task tree and writes would ride the wrong profile's sync.\n` +
    `To fix, either switch back to that profile in MLO, or close and reopen MLO so it records the profile ` +
    `you are actually using.`
  );
}

/** The whole policy, as a pure function of one observation. */
export function judgeProfile(observed: ProfileObservation | undefined): ProfileVerdict {
  if (!observed) return { ok: false, reason: "no-profile", message: PROBE_FAILED };
  const candidate = observed.lastDbFile;
  if (!candidate) return { ok: false, reason: "no-profile", message: NO_PROFILE_AT_ALL };
  if (!observed.lastDbFileExists) {
    return {
      ok: false,
      reason: "no-profile",
      message:
        `MLO's settings point at ${candidate}, which no longer exists. ` +
        `Open the profile you want to use in MLO so the server can detect it.`,
    };
  }
  // Nothing to contradict the registry: with MLO closed there is no open profile.
  if (!observed.appRunning) return { ok: true, dataFile: candidate };

  const openNames = openProfileNames(observed.windowTitles);
  const wanted = path.win32.basename(candidate).toLowerCase();
  const titleRefutes = openNames.length > 0 && !openNames.some((n) => n.toLowerCase() === wanted);
  // Only a definite negative refutes; an untestable lock leaves the candidate standing.
  const lockRefutes = observed.lastDbFileHeldByOther === false;
  if (titleRefutes || lockRefutes) {
    return { ok: false, reason: "profile-switched", message: switchedMessage(candidate, openNames) };
  }
  return { ok: true, dataFile: candidate };
}

/**
 * One PowerShell round trip for the whole observation — the registry value, the
 * running processes and their titles, and the exclusive-open test. PowerShell
 * rather than reg.exe because reg.exe emits the OEM codepage and would garble
 * non-ASCII profile paths; one script rather than three because this also runs
 * on a timer. Node cannot make the exclusive-open test itself: libuv only asks
 * for a deny-all share mode via `O_EXLOCK`, which Node does not define on
 * Windows.
 */
export function probeScript(processName: string): string {
  const name = processName.replaceAll("'", "''");
  return [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$ErrorActionPreference='SilentlyContinue'",
    "$last=(Get-ItemProperty 'HKCU:\\Software\\MyLifeOrganized.net\\MyLife\\Settings').LastDBFile",
    "$exists=$false; $held=$null",
    "if ($last) { $exists=[bool](Test-Path -LiteralPath $last -PathType Leaf)",
    // FileAccess::Read so a read-only profile is not mistaken for a held one;
    // FileShare::None so the open fails precisely when someone else holds it.
    "  if ($exists) { try { $h=[System.IO.File]::Open($last,[System.IO.FileMode]::Open," +
      "[System.IO.FileAccess]::Read,[System.IO.FileShare]::None); $h.Close(); $held=$false }",
    "    catch { $held=$true } } }",
    // Filtered enumeration, not -Name: -Name takes wildcards, and an exe named
    // with a bracket or star would silently match unrelated processes.
    `$procs=@(Get-Process | Where-Object { $_.ProcessName -ieq '${name}' })`,
    "[pscustomobject]@{ lastDbFile=$last; lastDbFileExists=$exists; appRunning=($procs.Count -gt 0);" +
      " windowTitles=@($procs | ForEach-Object { $_.MainWindowTitle }); lastDbFileHeldByOther=$held }" +
      " | ConvertTo-Json -Compress",
  ].join("\n");
}

function psArgs(processName: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", probeScript(processName)];
}

/** Every key the probe script is contracted to emit, present even when null. */
export const PROBE_FIELDS = [
  "lastDbFile",
  "lastDbFileExists",
  "appRunning",
  "windowTitles",
  "lastDbFileHeldByOther",
] as const;

/**
 * Tolerant of everything PowerShell does to a *value* on the way out \u2014 a lone
 * array element collapsed to a scalar, an unset registry value as null \u2014 but
 * strict about the *keys*. `ConvertTo-Json` emits every property of the
 * pscustomobject, so a missing key means the script and this parser have
 * drifted apart. Coercing that to "no signal available" would silently disarm
 * detection (the permissive direction); failing the parse instead surfaces it
 * as a refusal to start.
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
  const file = typeof raw.lastDbFile === "string" ? raw.lastDbFile.trim() : "";
  // ConvertTo-Json renders a one-element array as a bare scalar.
  const titles = raw.windowTitles;
  return {
    lastDbFile: file || undefined,
    lastDbFileExists: raw.lastDbFileExists === true,
    appRunning: raw.appRunning === true,
    windowTitles: (Array.isArray(titles) ? titles : typeof titles === "string" ? [titles] : []).filter(
      (t): t is string => typeof t === "string"
    ),
    lastDbFileHeldByOther: typeof raw.lastDbFileHeldByOther === "boolean" ? raw.lastDbFileHeldByOther : undefined,
  };
}

/**
 * mlo.exe → "mlo": the process to look for, honoring an MLO_EXE_PATH override.
 *
 * The extension strip must be case-insensitive, which `basename(p, ".exe")` is
 * not: it would leave "MLO.EXE" intact, match no process (Windows reports
 * process names without the extension), and report MLO as not running — which
 * accepts the registry candidate unchecked. A casing difference in one env var
 * would have quietly restored the exact bug this module exists to prevent.
 */
export function processNameFor(mloExePath: string): string {
  return path.win32.basename(mloExePath).replace(/\.exe$/i, "");
}

const PROBE_TIMEOUT_MS = 10_000;

/** undefined when the probe could not be run or its output was unusable. */
export function probeProfileSync(mloExePath: string): ProfileObservation | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("powershell.exe", psArgs(processNameFor(mloExePath)), {
    encoding: "utf8",
    windowsHide: true,
    timeout: PROBE_TIMEOUT_MS,
  });
  return result.stdout ? parseObservation(result.stdout) : undefined;
}

/** Non-blocking variant for the periodic profile-switch watcher in index.ts. */
export function probeProfile(mloExePath: string): Promise<ProfileObservation | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      psArgs(processNameFor(mloExePath)),
      { encoding: "utf8", windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (_err, stdout) => resolve(stdout ? parseObservation(stdout) : undefined)
    );
  });
}

export function detectProfileSync(mloExePath: string): ProfileVerdict {
  return judgeProfile(probeProfileSync(mloExePath));
}

export async function detectProfile(mloExePath: string): Promise<ProfileVerdict> {
  return judgeProfile(await probeProfile(mloExePath));
}

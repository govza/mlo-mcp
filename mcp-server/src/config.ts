import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { DEFAULT_CLOUD_PORT } from "./cloud/server.js";
import { log } from "./log.js";
import type { MloConfig } from "./types.js";

const DEFAULT_EXE = "C:\\Program Files (x86)\\MyLifeOrganized.net\\MLO\\mlo.exe";

// MLO records the profile it currently has open (and reopens on the next
// launch) in HKCU\...\Settings\LastDBFile, so the server can follow whatever
// profile mlo.exe is actually running without any configuration. Read via
// PowerShell rather than reg.exe: reg.exe emits the OEM codepage and would
// garble non-ASCII profile paths.
const LAST_DB_FILE_PS_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
    "(Get-ItemProperty 'HKCU:\\Software\\MyLifeOrganized.net\\MyLife\\Settings' -ErrorAction SilentlyContinue).LastDBFile",
];

function parseLastDbFile(stdout: string): string | undefined {
  const file = stdout.replace(/^\uFEFF/, "").trim();
  return file && existsSync(file) ? file : undefined;
}

function detectRunningProfile(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("powershell.exe", LAST_DB_FILE_PS_ARGS, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  return parseLastDbFile(result.stdout);
}

/** Non-blocking variant for the periodic profile-switch watcher in index.ts. */
export function detectRunningProfileAsync(): Promise<string | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      LAST_DB_FILE_PS_ARGS,
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      (err, stdout) => resolve(err ? undefined : parseLastDbFile(stdout))
    );
  });
}

// The app's open profile is the only one the server can fully operate on
// (reads drive mlo.exe, writes ride that profile's sync), so there is no
// profile setting: detect it or refuse to start. `--data-file=` exists for
// the test harness alone — it runs mlo.exe on temp copies with the GUI
// closed, where following the registry would hit the developer's real profile.
function resolveDataFile(): { dataFile: string; autoDetected: boolean } {
  const pin = process.argv.find((a) => a.startsWith("--data-file="));
  if (pin) return { dataFile: pin.slice("--data-file=".length), autoDetected: false };
  const detected = detectRunningProfile();
  if (detected) {
    log(`auto-detected MLO profile: ${detected}`);
    return { dataFile: detected, autoDetected: true };
  }
  throw new Error(
    "No MLO profile found: MLO's settings record no last-opened profile. " +
      "Open your profile in MLO once so the server can detect it."
  );
}

// One automatic private root outside any checkout; every profile gets its own
// partition under it, keyed by dataFileUID. MLO_CLOUD_STATE_ROOT exists for
// tests and unusual installs, not routine configuration.
function resolveStateRoot(): string {
  if (process.env.MLO_CLOUD_STATE_ROOT) return process.env.MLO_CLOUD_STATE_ROOT;
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "mlo-mcp", "cloud");
  return path.join(os.homedir(), ".mlo-mcp", "cloud");
}

export function loadConfig(): MloConfig {
  const { dataFile, autoDetected } = resolveDataFile();

  const cloudPort = Number(process.env.MLO_CLOUD_PORT ?? String(DEFAULT_CLOUD_PORT));
  if (!Number.isInteger(cloudPort) || cloudPort < 0 || cloudPort > 65535) {
    throw new Error("MLO_CLOUD_PORT must be an integer from 0 through 65535");
  }
  return {
    mloExePath: process.env.MLO_EXE_PATH ?? DEFAULT_EXE,
    dataFile,
    dataFileAutoDetected: autoDetected,
    exportDir: process.env.MLO_EXPORT_DIR ?? path.join(os.tmpdir(), "mlo-mcp"),
    cacheStaleMs: Number(process.env.MLO_CACHE_STALE_MS) || 30_000,
    // Only needed when the capture inbox is NOT MLO's own <Inbox> node (e.g. a
    // hand-made "Входящие" folder). MLO itself hardcodes the caption "<Inbox>"
    // in every UI language, so most profiles need no override.
    inboxCaption: process.env.MLO_INBOX_CAPTION || undefined,
    cloudHost: process.env.MLO_CLOUD_HOST ?? "127.0.0.1",
    cloudPort,
    cloudStateRoot: resolveStateRoot(),
  };
}

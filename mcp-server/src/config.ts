import path from "node:path";
import os from "node:os";
import { detectProfileSync } from "./profile-detect.js";
import { log } from "./log.js";
import type { MloConfig } from "./types.js";

/** Exported so tests can name the real default instead of restating the literal. */
export const DEFAULT_EXE = "C:\\Program Files (x86)\\MyLifeOrganized.net\\MLO\\mlo.exe";

/**
 * Set to `true` by esbuild when it produces dist-bundle/mlo-mcp.js — the only
 * artifact `files` ships, so it is exactly the "installed" case. Running from
 * source (tsx, `pnpm tool`, the tsc output under dist/) leaves it undefined.
 */
declare const __MLO_BUNDLED__: boolean | undefined;
const BUNDLED = typeof __MLO_BUNDLED__ !== "undefined" && __MLO_BUNDLED__;

/**
 * Default listen port; off the crowded 8080 so dev servers don't collide with it.
 *
 * Two defaults, because a contributor's checkout and their installed server run
 * against the same machine and the same MLO: an installed server takes 8181,
 * which is the port every install doc tells users to point MLO's proxy at, and
 * a source checkout takes 8282, the port the disposable Demo profile and the
 * live-write harness already use. So working on the code cannot take over the
 * listener the installed server owns, and MLO's two profiles each reach the
 * endpoint they mean. `MLO_CLOUD_PORT` overrides either one.
 */
export const DEFAULT_CLOUD_PORT = BUNDLED ? 8181 : 8282;

/**
 * How long an accepted write may wait for MLO's Apply before it expires into
 * the dead-letter file (spec section 2, mechanic 7). 15 minutes by default;
 * MLO_WRITE_TTL_MINUTES overrides.
 */
export const DEFAULT_WRITE_TTL_MS = 15 * 60_000;

// The app's open profile is the only one the server can fully operate on
// (reads drive mlo.exe, writes ride that profile's sync), so there is no
// profile setting: detect it or refuse to start. Detection asks the running
// app and nothing else — see profile-detect.ts for why nothing MLO saved for
// next time may stand in for it.
// `--data-file=` exists for the test harness alone — it runs mlo.exe on temp
// copies with the GUI closed, where detection has no running app to ask.
function resolveDataFile(mloExePath: string): { dataFile: string; autoDetected: boolean } {
  const pin = process.argv.find((a) => a.startsWith("--data-file="));
  if (pin) return { dataFile: pin.slice("--data-file=".length), autoDetected: false };
  const verdict = detectProfileSync(mloExePath);
  if (!verdict.ok) throw new Error(verdict.message);
  log(`auto-detected MLO profile: ${verdict.dataFile}`);
  return { dataFile: verdict.dataFile, autoDetected: true };
}

// One automatic private root outside any checkout; every profile gets its own
// partition under it, keyed by dataFileUID. MLO_CLOUD_STATE_ROOT exists for
// tests and unusual installs, not routine configuration.
function resolveStateRoot(): string {
  if (process.env.MLO_CLOUD_STATE_ROOT) return process.env.MLO_CLOUD_STATE_ROOT;
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "mlo-mcp", "cloud");
  return path.join(os.homedir(), ".mlo-mcp", "cloud");
}

export interface CloudConfig {
  cloudHost: string;
  cloudPort: number;
  cloudStateRoot: string;
  writeTtlMs: number;
  /**
   * The resident needs this too, and not to run anything: auto-initialization
   * asks the running app which profile it has open, and the probe finds the app
   * by this executable's name (and a portable install's log beside it).
   */
  mloExePath: string;
}

/**
 * Everything the sync endpoint needs, and nothing else. The resident endpoint
 * serves partitions keyed by `dataFileUID`, not profiles: it must come up (and
 * stay up) across profile switches and before MLO has ever been opened, so it
 * must not inherit `resolveDataFile()`'s refusal to start without one.
 */
export function loadCloudConfig(): CloudConfig {
  const cloudPort = Number(process.env.MLO_CLOUD_PORT ?? String(DEFAULT_CLOUD_PORT));
  if (!Number.isInteger(cloudPort) || cloudPort < 0 || cloudPort > 65535) {
    throw new Error("MLO_CLOUD_PORT must be an integer from 0 through 65535");
  }
  const ttlMinutes = Number(process.env.MLO_WRITE_TTL_MINUTES ?? "");
  return {
    cloudHost: process.env.MLO_CLOUD_HOST ?? "127.0.0.1",
    cloudPort,
    cloudStateRoot: resolveStateRoot(),
    // `||`, not `??`: a blank override would yield an empty process name, match
    // no process, and make detection report MLO as closed — which is now a
    // refusal to start on a machine that has a profile plainly open.
    mloExePath: process.env.MLO_EXE_PATH || DEFAULT_EXE,
    writeTtlMs: Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60_000 : DEFAULT_WRITE_TTL_MS,
  };
}

export function loadConfig(): MloConfig {
  // Before the data file: detection looks for mlo.exe's process by name, and
  // that name comes from the cloud config's `mloExePath` (which the resident
  // needs for the same probe).
  const cloud = loadCloudConfig();
  const { dataFile, autoDetected } = resolveDataFile(cloud.mloExePath);
  return {
    dataFile,
    dataFileAutoDetected: autoDetected,
    exportDir: process.env.MLO_EXPORT_DIR ?? path.join(os.tmpdir(), "mlo-mcp"),
    cacheStaleMs: Number(process.env.MLO_CACHE_STALE_MS) || 30_000,
    quickSyncDebounceMs: Number(process.env.MLO_QUICKSYNC_DEBOUNCE_MS) || 300_000,
    // Only needed when the capture inbox is NOT MLO's own <Inbox> node (e.g. a
    // hand-made "Входящие" folder). MLO itself hardcodes the caption "<Inbox>"
    // in every UI language, so most profiles need no override.
    inboxCaption: process.env.MLO_INBOX_CAPTION || undefined,
    ...cloud,
  };
}

import path from "node:path";
import os from "node:os";
import { DEFAULT_CLOUD_PORT } from "./cloud/server.js";
import { detectProfileSync } from "./profile-detect.js";
import { log } from "./log.js";
import type { MloConfig } from "./types.js";

/** Exported so tests can name the real default instead of restating the literal. */
export const DEFAULT_EXE = "C:\\Program Files (x86)\\MyLifeOrganized.net\\MLO\\mlo.exe";

// The app's open profile is the only one the server can fully operate on
// (reads drive mlo.exe, writes ride that profile's sync), so there is no
// profile setting: detect it or refuse to start. Detection grounds the
// registry's candidate against the running app rather than trusting it — see
// profile-detect.ts for why the registry value alone is not enough.
// `--data-file=` exists for the test harness alone — it runs mlo.exe on temp
// copies with the GUI closed, where following the registry would hit the
// developer's real profile.
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
  return {
    cloudHost: process.env.MLO_CLOUD_HOST ?? "127.0.0.1",
    cloudPort,
    cloudStateRoot: resolveStateRoot(),
  };
}

export function loadConfig(): MloConfig {
  // Before the data file: detection looks for this exe's process by name, so an
  // MLO_EXE_PATH override has to reach it. `||`, not `??`: a blank override
  // would yield an empty process name, match nothing, and make detection report
  // MLO as closed — which accepts the registry candidate unchecked.
  const mloExePath = process.env.MLO_EXE_PATH || DEFAULT_EXE;
  const { dataFile, autoDetected } = resolveDataFile(mloExePath);
  return {
    mloExePath,
    dataFile,
    dataFileAutoDetected: autoDetected,
    exportDir: process.env.MLO_EXPORT_DIR ?? path.join(os.tmpdir(), "mlo-mcp"),
    cacheStaleMs: Number(process.env.MLO_CACHE_STALE_MS) || 30_000,
    // Only needed when the capture inbox is NOT MLO's own <Inbox> node (e.g. a
    // hand-made "Входящие" folder). MLO itself hardcodes the caption "<Inbox>"
    // in every UI language, so most profiles need no override.
    inboxCaption: process.env.MLO_INBOX_CAPTION || undefined,
    ...loadCloudConfig(),
  };
}

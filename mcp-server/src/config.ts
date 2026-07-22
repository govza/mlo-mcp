import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_CLOUD_PORT } from "./cloud/server.js";
import type { MloConfig } from "./types.js";

const DEFAULT_EXE = "C:\\Program Files (x86)\\MyLifeOrganized.net\\MLO\\mlo.exe";

// Repo checkouts fall back to the demo profile (see profile/README.md) so
// `pnpm dev` / `pnpm tool` work without MLO_DATA_FILE. Resolved relative to
// this file, two levels below the repo root in src/, dist/, and dist-bundle/
// alike; the published npm package ships no profile/, so installs from npm
// still get the hard error below.
const DEV_PROFILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "profile",
  "profile.ml"
);

function resolveDataFile(): string {
  if (process.env.MLO_DATA_FILE) return process.env.MLO_DATA_FILE;
  if (existsSync(DEV_PROFILE)) return DEV_PROFILE;
  throw new Error(
    "MLO_DATA_FILE environment variable is required. Set it to the path of your .ml data file."
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
  const dataFile = resolveDataFile();

  const cloudPort = Number(process.env.MLO_CLOUD_PORT ?? String(DEFAULT_CLOUD_PORT));
  if (!Number.isInteger(cloudPort) || cloudPort < 0 || cloudPort > 65535) {
    throw new Error("MLO_CLOUD_PORT must be an integer from 0 through 65535");
  }
  return {
    mloExePath: process.env.MLO_EXE_PATH ?? DEFAULT_EXE,
    dataFile,
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

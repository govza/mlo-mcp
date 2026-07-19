import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// Keep generated cloud messages out of profile/ and in one repo-local,
// git-ignored directory. Packaged installs can override this as usual with
// MLO_CLOUD_STATE_DIR.
const DEV_CLOUD_STATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "messages"
);

function resolveDataFile(): string {
  if (process.env.MLO_DATA_FILE) return process.env.MLO_DATA_FILE;
  if (existsSync(DEV_PROFILE)) return DEV_PROFILE;
  throw new Error(
    "MLO_DATA_FILE environment variable is required. Set it to the path of your .ml data file."
  );
}

export function loadConfig(): MloConfig {
  const dataFile = resolveDataFile();

  const cloudPort = Number(process.env.MLO_CLOUD_PORT ?? "8080");
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
    cloudStateDir: process.env.MLO_CLOUD_STATE_DIR ?? DEV_CLOUD_STATE_DIR,
  };
}

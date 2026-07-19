import path from "node:path";
import os from "node:os";
import type { MloConfig } from "./types.js";

const DEFAULT_EXE = "C:\\Program Files (x86)\\MyLifeOrganized.net\\MLO\\mlo.exe";

export function loadConfig(): MloConfig {
  const dataFile = process.env.MLO_DATA_FILE;
  if (!dataFile) {
    throw new Error(
      "MLO_DATA_FILE environment variable is required. Set it to the path of your .ml data file."
    );
  }

  const cloudPort = Number(process.env.MLO_CLOUD_PORT ?? "8080");
  if (!Number.isInteger(cloudPort) || cloudPort < 0 || cloudPort > 65535) {
    throw new Error("MLO_CLOUD_PORT must be an integer from 0 through 65535");
  }
  return {
    mloExePath: process.env.MLO_EXE_PATH ?? DEFAULT_EXE,
    dataFile,
    exportDir: process.env.MLO_EXPORT_DIR ?? path.join(os.tmpdir(), "mlo-mcp"),
    cacheStaleMs: Number(process.env.MLO_CACHE_STALE_MS) || 30_000,
    // When a write needs the GUI gone, close it gracefully (it saves on close,
    // same as clicking X), apply the change, and relaunch it on the same file.
    // Set MLO_AUTO_RESTART_GUI=0 to refuse writes instead while MLO is open.
    autoRestartGui: !["0", "false", "no"].includes((process.env.MLO_AUTO_RESTART_GUI ?? "1").toLowerCase()),
    // "minimized" relaunches without popping a window into focus; "normal"
    // restores the old behavior; "none" leaves MLO closed after writes.
    relaunchStyle: (["minimized", "normal", "none"].includes((process.env.MLO_RELAUNCH_STYLE ?? "").toLowerCase())
      ? (process.env.MLO_RELAUNCH_STYLE as string).toLowerCase()
      : "minimized") as MloConfig["relaunchStyle"],
    // Only needed when the capture inbox is NOT MLO's own <Inbox> node (e.g. a
    // hand-made "Входящие" folder). MLO itself hardcodes the caption "<Inbox>"
    // in every UI language, so most profiles need no override.
    inboxCaption: process.env.MLO_INBOX_CAPTION || undefined,
    cloudMode: ["1", "true", "yes"].includes((process.env.MLO_CLOUD_MODE ?? "0").toLowerCase()),
    cloudHost: process.env.MLO_CLOUD_HOST ?? "127.0.0.1",
    cloudPort,
    cloudStateDir: process.env.MLO_CLOUD_STATE_DIR ?? `${dataFile}.mcp-cloud`,
  };
}

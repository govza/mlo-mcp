import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { MloConfig } from "../../src/types.js";

export const MLO_EXE = process.env.MLO_EXE_PATH ?? "C:\\Program Files (x86)\\MyLifeOrganized.net\\MLO\\mlo.exe";
export const SOURCE_PROFILE = path.resolve(__dirname, "..", "..", "..", "profile", "profile.ml");

export const mloInstalled = existsSync(MLO_EXE) && existsSync(SOURCE_PROFILE);

export function assertGuiClosed(): void {
  const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq mlo.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (out.toLowerCase().includes("mlo.exe")) {
    throw new Error("mlo.exe is running — close the MyLifeOrganized app before running the mlo test project");
  }
}

export interface TestEnv {
  config: MloConfig;
  dir: string;
  cleanup: () => void;
}

/** Copy the test profile to a temp working copy — tests never touch the original. */
export function makeTestEnv(): TestEnv {
  const dir = path.join(os.tmpdir(), `mlo-mcp-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dataFile = path.join(dir, "work.ml");
  copyFileSync(SOURCE_PROFILE, dataFile);
  return {
    dir,
    config: {
      mloExePath: MLO_EXE,
      dataFile,
      exportDir: path.join(dir, "exports"),
      cacheStaleMs: 30_000,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

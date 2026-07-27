import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { ResidentEndpoint } from "../../src/cloud/endpoint.js";
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

/**
 * A concrete free port, not port 0: the resident endpoint is spawned as its
 * own process, so the port has to be one both sides can name in advance.
 */
export async function reserveFreePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/** Ask a resident endpoint to exit, so a test never leaks a detached process. */
export async function stopResidentEndpoint(port: number): Promise<void> {
  await new ResidentEndpoint("127.0.0.1", port).requestShutdown().catch(() => undefined);
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
      cloudHost: "127.0.0.1",
      // The suites that spawn a resident reserve their own port and state root;
      // this is the shape a config must have, not a live endpoint.
      cloudPort: 0,
      cloudStateRoot: path.join(dir, "cloud-state"),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

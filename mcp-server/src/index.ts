import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, detectRunningProfileAsync } from "./config.js";
import type { MloConfig } from "./types.js";
import { isMloBusy } from "./mlo-cli.js";
import { MloStore } from "./store.js";
import { log } from "./log.js";
import { createMcpServer } from "./server.js";
import { CloudGateway } from "./cloud/gateway.js";
import { startOrAttachCloudServer, type CloudServerHandle, type EndpointRole } from "./cloud/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MloStore(config);
  const cloud = new CloudGateway({ stateRoot: config.cloudStateRoot });
  // undefined = another session already serves the endpoint; this one shares
  // the delta log via CloudState's cross-process locking and needs no listener.
  // The role is threaded into the tool context because vendor contacts live in
  // the owner's memory only: bootstrap and upstream writes work there alone.
  const cloudServer = await startOrAttachCloudServer({ host: config.cloudHost, port: config.cloudPort, gateway: cloud });
  const ctx = {
    config,
    store,
    cloudState: cloud.defaultState(),
    cloud,
    endpointRole: (cloudServer ? "owner" : "attached") as EndpointRole,
  };

  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  log(`ready — data file: ${config.dataFile}`);
  watchOwnBuild(cloudServer);
  watchProfileSwitch(config, cloudServer);
  const shutdown = async () => {
    await cloudServer?.stop();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

/**
 * Long-lived sessions kept running stale server builds after every rebuild
 * (stdio servers live as long as the client connection). Watch our own entry
 * file; when a rebuild changes it, exit cleanly while idle so the client
 * respawns the current code on the next tool call.
 */
function watchOwnBuild(cloudServer: CloudServerHandle | undefined): void {
  const entry = fileURLToPath(import.meta.url);
  let startMtime: number | undefined;
  const timer = setInterval(async () => {
    try {
      const mtime = (await fs.stat(entry)).mtimeMs;
      startMtime ??= mtime;
      if (mtime !== startMtime && !isMloBusy()) {
        log("server build changed on disk — exiting so the client restarts the new version");
        await cloudServer?.stop();
        process.exit(0);
      }
    } catch {
      /* transient stat failure (mid-rebuild) — retry next tick */
    }
  }, 15_000);
  timer.unref();
}

/**
 * An auto-detected profile is a snapshot: if the user opens a different
 * profile in MLO mid-session, this long-lived process would keep serving the
 * old one. Same remedy as watchOwnBuild — poll the registry value and exit
 * cleanly while idle so the client respawns against the new profile on the
 * next tool call. Never fires when a --data-file test pin is in effect.
 */
function watchProfileSwitch(config: MloConfig, cloudServer: CloudServerHandle | undefined): void {
  if (!config.dataFileAutoDetected) return;
  const timer = setInterval(async () => {
    const current = await detectRunningProfileAsync();
    if (current && current !== config.dataFile && !isMloBusy()) {
      log(`MLO switched profiles (${config.dataFile} → ${current}) — exiting so the client restarts against it`);
      await cloudServer?.stop();
      process.exit(0);
    }
  }, 60_000);
  timer.unref();
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

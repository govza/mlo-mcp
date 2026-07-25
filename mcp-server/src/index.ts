import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCloudConfig, loadConfig, detectRunningProfileAsync } from "./config.js";
import type { MloConfig } from "./types.js";
import { isMloBusy } from "./mlo-cli.js";
import { MloStore } from "./store.js";
import { log } from "./log.js";
import { createMcpServer } from "./server.js";
import { CloudGateway } from "./cloud/gateway.js";
import { ensureEndpoint, residentSpawner, RESIDENT_FLAG } from "./cloud/endpoint.js";
import { startCloudServer } from "./cloud/server.js";

async function main(): Promise<void> {
  // Same file, two jobs. The resident endpoint has to be reachable from every
  // install layout (dist/, dist-bundle/, tsx over src/), and re-invoking this
  // entry point is the only way to spawn it that needs no path discovery.
  if (process.argv.includes(RESIDENT_FLAG)) return serveResidentEndpoint();

  const config = loadConfig();
  const store = new MloStore(config);
  const cloud = new CloudGateway({ stateRoot: config.cloudStateRoot });
  // Never a listener of its own: MLO's proxy points at this port permanently,
  // so a session that owned it would take the app's sync down when it closed.
  // Attach to the resident process, starting it if nothing answers.
  const endpoint = await ensureEndpoint({
    host: config.cloudHost,
    port: config.cloudPort,
    spawn: residentSpawner(fileURLToPath(import.meta.url)),
  });
  const ctx = { config, store, cloudState: cloud.defaultState(), cloud, endpoint };

  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  log(`ready — data file: ${config.dataFile}`);
  watchOwnBuild();
  watchProfileSwitch(config);
}

/**
 * The resident endpoint: one long-lived process serving the loopback port that
 * MLO's proxy is permanently pointed at
 * ([ADR-0003](../../docs/adr/0003-resident-endpoint.md)). It outlives every MCP
 * session, holds the vendor contacts scraped from MLO's own proxied traffic,
 * and is the only performer of upstream sync sessions.
 *
 * It deliberately runs neither watcher below. It follows no profile (partitions
 * are keyed by `dataFileUID`, so a profile switch is not its business), and it
 * does not exit on a rebuild — a newer session replaces it instead, which is
 * the one path that guarantees something is listening afterwards.
 */
async function serveResidentEndpoint(): Promise<void> {
  const config = loadCloudConfig();
  const gateway = new CloudGateway({ stateRoot: config.cloudStateRoot });
  const handle = await startCloudServer({ host: config.cloudHost, port: config.cloudPort, gateway });
  log(`resident cloud endpoint serving on http://${handle.host}:${handle.port} (state root: ${config.cloudStateRoot})`);
  const stop = () => void handle.stop().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/**
 * Long-lived sessions kept running stale server builds after every rebuild
 * (stdio servers live as long as the client connection). Watch our own entry
 * file; when a rebuild changes it, exit cleanly while idle so the client
 * respawns the current code on the next tool call.
 */
function watchOwnBuild(): void {
  const entry = fileURLToPath(import.meta.url);
  let startMtime: number | undefined;
  const timer = setInterval(async () => {
    try {
      const mtime = (await fs.stat(entry)).mtimeMs;
      startMtime ??= mtime;
      if (mtime !== startMtime && !isMloBusy()) {
        log("server build changed on disk — exiting so the client restarts the new version");
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
function watchProfileSwitch(config: MloConfig): void {
  if (!config.dataFileAutoDetected) return;
  const timer = setInterval(async () => {
    const current = await detectRunningProfileAsync();
    if (current && current !== config.dataFile && !isMloBusy()) {
      log(`MLO switched profiles (${config.dataFile} → ${current}) — exiting so the client restarts against it`);
      process.exit(0);
    }
  }, 60_000);
  timer.unref();
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

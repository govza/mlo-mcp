import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCloudConfig, loadConfig } from "./config.js";
import { detectProfile } from "./profile-detect.js";
import type { MloConfig } from "./types.js";
import { isMloBusy, SystemMloCli } from "./repo/mlo-cli.js";
import { LocalMloRepository } from "./repo/local-mlo-repository.js";
import { HttpResidentClient } from "./repo/resident-client.js";
import { createToolContext } from "./context.js";
import { log, mirrorLogToFile } from "./log.js";
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
  // The drivers are wired here and nowhere else — above the repository they do
  // not exist. The ResidentClient attaches (and spawns) lazily on the call
  // that needs it, so a resident that dies mid-session comes back on the next
  // write instead of requiring a client restart.
  const spawn = residentSpawner(fileURLToPath(import.meta.url));
  const resident = new HttpResidentClient({ host: config.cloudHost, port: config.cloudPort, spawn });
  const cloud = new CloudGateway({ stateRoot: config.cloudStateRoot });
  // The bound partition's stores, resolved once: the queue makes the repository's
  // reads show this session's own accepted writes, the row store is what writes
  // are authored from.
  const { rows, queue } = await cloud.boundStores(config.dataFile);
  const repo = new LocalMloRepository(config, new SystemMloCli(config), resident, queue);
  // Never a listener of its own: MLO's proxy points at this port permanently,
  // so a session that owned it would take the app's sync down when it closed.
  // Attach to the resident process, starting it if nothing answers.
  const endpoint = await ensureEndpoint({
    host: config.cloudHost,
    port: config.cloudPort,
    spawn,
  });
  const ctx = createToolContext(config, repo, cloud, endpoint, rows);

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
 * session and holds the vendor contacts scraped from MLO's own proxied traffic.
 *
 * It deliberately runs neither watcher below. It follows no profile (partitions
 * are keyed by `dataFileUID`, so a profile switch is not its business), and it
 * does not exit on a rebuild — a newer session replaces it instead, which is
 * the one path that guarantees something is listening afterwards.
 */
async function serveResidentEndpoint(): Promise<void> {
  const config = loadCloudConfig();
  // The resident is spawned detached with its stdio discarded, so this file is
  // the only place its log (auto-init refusals above all) survives.
  mirrorLogToFile(path.join(config.cloudStateRoot, "resident.log"));
  const gateway = new CloudGateway({ stateRoot: config.cloudStateRoot });
  const handle = await startCloudServer({
    host: config.cloudHost,
    port: config.cloudPort,
    gateway,
    writeTtlMs: config.writeTtlMs,
    // What lets the resident bind a cloud file by itself: it asks the running
    // app which profile is open, and pulls with the contact it captured.
    mloExePath: config.mloExePath,
  });
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
 * old one. Same remedy as watchOwnBuild — re-detect periodically and exit
 * cleanly while idle so the client respawns on the next tool call. Never fires
 * when a --data-file test pin is in effect.
 *
 * A refusal is a reason to exit too: it means the running app no longer has our
 * profile open — or is no longer running at all, which under process-only
 * detection is the same thing (ADR-0006). A session that stayed up would keep
 * answering from a profile nothing has open. The respawn re-runs detection,
 * which refuses in loadConfig() and exits with the reason on stderr — the loud
 * failure we want, though a startup failure rather than a protocol error, since
 * there is no connected session to fail. Only the two *definite* refusals
 * qualify; "profile-undetectable" means the probe could not tell (it failed, or
 * MLO's log was unreadable) and must not cycle a working session.
 */
function watchProfileSwitch(config: MloConfig): void {
  if (!config.dataFileAutoDetected) return;
  const timer = setInterval(async () => {
    // Before probing, not after: the probe opens the data file denying all
    // sharing, and doing that mid-operation is the very contention the data
    // file's lock exists to prevent. Re-checked on the next tick.
    if (isMloBusy()) return;
    const verdict = await detectProfile(config.mloExePath);
    if (isMloBusy()) return; // an operation started while the probe ran
    if (verdict.ok && verdict.dataFile !== config.dataFile) {
      log(`MLO switched profiles (${config.dataFile} → ${verdict.dataFile}) — exiting so the client restarts against it`);
      process.exit(0);
    }
    if (!verdict.ok && verdict.reason !== "profile-undetectable") {
      log(`MLO no longer has ${config.dataFile} open — exiting rather than serving it: ${verdict.message}`);
      process.exit(0);
    }
  }, 60_000);
  timer.unref();
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

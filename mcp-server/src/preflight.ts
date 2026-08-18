import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCloudConfig, loadConfig } from "./config.js";
import { detectProfile } from "./profile-detect.js";
import { SystemMloCli } from "./repo/mlo-cli.js";
import { CloudGateway } from "./cloud/gateway.js";
import { ensureEndpoint, probe, residentSpawner, type EndpointSpawner } from "./cloud/endpoint.js";

const exec = promisify(execFile);

/**
 * `--preflight`: a dev-environment doctor run before an MCP session connects
 * (typically from a SessionStart hook). It heals what a session's own startup
 * would not touch — a wedged foreign listener on the sync port, a resident
 * serving a different state root — and reports what only the user can fix.
 * Everything it prints goes to stdout so a hook can inject it as context.
 *
 * Always exits 0 unless preflight itself crashed: its findings are context,
 * not a gate — a broken sync plane still leaves reads working.
 */
export async function runPreflight(entry: string): Promise<void> {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  const cloud = loadCloudConfig();

  const verdict = await detectProfile(cloud.mloExePath);
  if (verdict.ok) say(`profile: ${verdict.dataFile} (open in MLO)`);
  else say(`PROBLEM: no open MLO profile detected (${verdict.message}) — reads and writes will refuse until MLO is running with a profile open`);

  await ensureHealthyEndpoint(cloud.cloudHost, cloud.cloudPort, cloud.cloudStateRoot, residentSpawner(entry), say);

  if (!verdict.ok) return;
  await reportBindingAndQueue(verdict.dataFile, cloud.cloudStateRoot, say);
}

/**
 * The session's own `ensureEndpoint` refuses to touch a foreign listener and
 * attaches to any mlo-mcp endpoint regardless of state root. In a dev
 * environment both are wrong to live with, so preflight goes further: a
 * cross-root resident is asked to step aside, and a listener that is not an
 * endpoint at all is killed by PID — MLO's proxy points at this port, nothing
 * works until it is ours.
 */
async function ensureHealthyEndpoint(
  host: string,
  port: number,
  stateRoot: string,
  spawn: EndpointSpawner,
  say: (line: string) => void,
): Promise<void> {
  const found = await probe(host, port);
  if (found.kind === "foreign") {
    const pid = await pidListeningOn(port);
    if (pid === undefined) {
      say(`PROBLEM: port ${port} is held by something that is not an mlo-mcp endpoint (${found.detail}) and its process could not be identified — free the port by hand`);
      return;
    }
    try {
      process.kill(pid);
      say(`fixed: killed pid ${pid} — it held port ${port} without being an mlo-mcp endpoint (${found.detail})`);
    } catch (error) {
      say(`PROBLEM: could not kill pid ${pid} holding port ${port}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  if (found.kind === "endpoint" && found.status.stateRoot && found.status.stateRoot !== stateRoot) {
    say(
      `PROBLEM: the resident on port ${port} serves state root ${found.status.stateRoot}, this environment uses ${stateRoot} — ` +
        "two environments share one port; set MLO_CLOUD_STATE_ROOT/MLO_CLOUD_PORT apart or expect crossed bindings",
    );
  }
  const endpoint = await ensureEndpoint({ host, port, spawn });
  if (endpoint.reachable) say(`endpoint: ${endpoint.url} reachable (${endpoint.version ?? "version unknown"})`);
  else say(`PROBLEM: no resident endpoint came up on ${endpoint.url} — MLO's sync has nowhere to connect and writes will refuse`);
}

async function reportBindingAndQueue(dataFile: string, stateRoot: string, say: (line: string) => void): Promise<void> {
  const gateway = new CloudGateway({ stateRoot });
  const bound = await gateway.boundPartition(dataFile);
  if (bound.kind !== "bound") {
    const last = await gateway.autoInitOutcome.last();
    const why = last?.kind === "refused" ? ` (last bind attempt: ${last.problem.title})` : "";
    say(`PROBLEM: profile is not bound to a cloud file${why} — run one sync in MLO through the proxy so auto-initialization binds it, then writes deliver`);
    return;
  }
  say(`binding: ${bound.binding.dataFileUID} (${bound.binding.mode}, ${bound.lifecycle})`);
  const mismatch = await gateway.bindingMismatch(dataFile);
  if (mismatch) {
    say(`PROBLEM: binding mismatch — bound to ${mismatch.boundDataFileUID} but MLO last synced ${mismatch.observedDataFileUIDs.join(", ")}; the next proxied sync should recover it`);
  }

  const gauge = await bound.partition.writeGauge(5);
  if (gauge.deadLetters.length) {
    say(`PROBLEM: ${gauge.deadLetters.length} recent write(s) never landed: ${gauge.deadLetters.map((d) => `${d.caption ?? d.uid} (${d.status})`).join(", ")}`);
  }
  if (gauge.pendingWrites === 0) {
    say("queue: empty");
    return;
  }
  const age = gauge.oldestPendingAgeMs !== undefined ? `, oldest ${Math.round(gauge.oldestPendingAgeMs / 1000)}s` : "";
  say(`queue: ${gauge.pendingWrites} pending write(s)${age} — nudging MLO to sync them now`);
  await drainQueue(say);
}

/** Same affordability rule as the after-accept nudge: spend MLO's own QuickSync budget, never past it. */
async function drainQueue(say: (line: string) => void): Promise<void> {
  const config = loadConfig();
  const cli = new SystemMloCli(config);
  const count = await cli.quickSyncCount();
  if (count !== undefined && count >= config.quickSyncMaxPerWindow) {
    say(`queue: QuickSync budget spent (${count} this window) — pending writes ride MLO's own ~90s sync`);
    return;
  }
  try {
    await cli.quickSync();
    say("fixed: QuickSync fired — pending writes deliver on the session it opens");
  } catch (error) {
    say(`PROBLEM: QuickSync failed (${error instanceof Error ? error.message : String(error)}) — pending writes ride MLO's own ~90s sync`);
  }
}

/** win32 only; elsewhere the port has to be freed by hand. */
async function pidListeningOn(port: number): Promise<number | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await exec("netstat.exe", ["-ano", "-p", "tcp"]);
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (match && Number(match[1]) === port) return Number(match[2]);
    }
  } catch {
    /* fall through to "could not identify" */
  }
  return undefined;
}

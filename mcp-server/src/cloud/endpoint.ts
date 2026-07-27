import { spawn, type SpawnOptions } from "node:child_process";
import net from "node:net";
import { log } from "../log.js";
import { SERVER_INFO } from "../version.js";

/**
 * The resident sync endpoint, seen from an MCP session.
 *
 * MLO's proxy points at this port permanently — the app hardcodes the vendor
 * sync URL — so the listener has to outlive every agent session. One resident
 * process owns it and sessions only ever attach
 * ([ADR-0003](../../../docs/adr/0003-resident-endpoint.md)); the process that
 * happened to start first no longer wins a listener by accident.
 *
 * The seam is deliberately narrow: the resident proxies MLO's vendor sync and
 * answers status/shutdown, and executes no tools. Reads stay in the session,
 * against mlo.exe exports. A narrow HTTP contract survives a version gap
 * between the two processes; a tool-dispatch contract would not, and
 * auto-spawning makes stale resident processes inherent.
 */

/** Argument that turns this package's entry point into the resident endpoint. */
export const RESIDENT_FLAG = "--serve-cloud";

/**
 * What a user can actually do about a missing endpoint. Stated once because
 * three separate messages carry it, and because it must not over-promise: a
 * session starts the endpoint at ITS OWN startup and never re-checks, so one
 * that dies mid-session comes back when a client restarts — not on its own.
 */
export const ENDPOINT_RECOVERY =
  "A new MCP client session starts one automatically, so restarting this client is the fix; a session already " +
  "running will not start one by itself.";

const PROBE_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

export interface EndpointStatus {
  /** Absent from endpoints built before the resident model shipped. */
  version?: string;
  /** dataFileUIDs whose sync traffic the resident has seen since IT started. */
  contactUids: string[];
  stateRoot?: string;
  /**
   * Injected writes an MLO sync session has held unresolved long enough to read
   * as stalled — most likely a conflict dialog waiting on the user (spec
   * section 6). Absent — not empty — from an endpoint too old to report it, so
   * `cloud_status` can stay silent instead of claiming nothing is stalled.
   */
  writesHeldOpen?: string[];
}

/** Injected so the unit suite never launches a real detached process. */
export type EndpointSpawner = () => void | Promise<void>;

export interface EnsureEndpointOptions {
  host: string;
  port: number;
  spawn: EndpointSpawner;
  /** This build's version; overridable so skew handling is testable. */
  ourVersion?: string;
  /** How long a freshly spawned endpoint has to answer. */
  startTimeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compare dotted numeric versions. Non-numeric suffixes (`0.4.0-rc.1`) sort as
 * their leading number, which is enough: the question asked here is only ever
 * "is this session strictly newer than the process already serving the port".
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const a = Number.parseInt(leftParts[index] ?? "0", 10) || 0;
    const b = Number.parseInt(rightParts[index] ?? "0", 10) || 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Whether anything at all holds the port (distinguishes "free" from "taken"). */
function portIsTaken(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (taken: boolean) => { socket.destroy(); resolve(taken); };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

type Answer =
  | { kind: "endpoint"; status: EndpointStatus }
  /**
   * Holds the port without identifying itself as one of ours — a wrong HTTP
   * answer, or none at all. Both are the same fault to the user: MLO's proxy
   * points at this port, so nothing can be done until it is freed. Never
   * spawn over it, and never quietly live with it.
   */
  | { kind: "foreign"; detail: string };

async function askStatus(host: string, port: number): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/v1/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (error) {
    return { kind: "foreign", detail: `it accepts connections but does not answer /v1/status (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!response.ok) return { kind: "foreign", detail: `/v1/status answered HTTP ${response.status}` };
  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    return { kind: "foreign", detail: "/v1/status did not answer with JSON" };
  }
  // What makes the holder recognisably ours rather than some other local
  // server: current builds serve version + contactUids; builds from before the
  // delta log was deleted served cursor + entries, and must stay identifiable
  // so a newer session can replace them.
  const currentShape = typeof body.version === "string" && Array.isArray(body.contactUids);
  const legacyShape = typeof body.cursor === "string" && typeof body.entries === "object" && body.entries !== null;
  if (!currentShape && !legacyShape) {
    return { kind: "foreign", detail: "/v1/status answered without the fields an mlo-mcp endpoint serves" };
  }
  return {
    kind: "endpoint",
    status: {
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      contactUids: Array.isArray(body.contactUids) ? body.contactUids.filter((uid): uid is string => typeof uid === "string") : [],
      ...(typeof body.stateRoot === "string" ? { stateRoot: body.stateRoot } : {}),
      ...(Array.isArray(body.writesHeldOpen)
        ? { writesHeldOpen: body.writesHeldOpen.filter((id): id is string => typeof id === "string") }
        : {}),
    },
  };
}

async function readStatus(host: string, port: number): Promise<EndpointStatus | undefined> {
  const answer = await askStatus(host, port);
  return answer.kind === "endpoint" ? answer.status : undefined;
}

type Probe = { kind: "free" } | Answer;

async function probe(host: string, port: number): Promise<Probe> {
  if (!(await portIsTaken(host, port, PROBE_TIMEOUT_MS))) return { kind: "free" };
  // A reachable HTTP server that is not ours is a configuration fault the user
  // must resolve; a listener that says nothing at all might be ours mid-start,
  // so it is reported rather than overwritten.
  return askStatus(host, port);
}

async function waitFor<T>(deadlineMs: number, attempt: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Attach to the resident endpoint, starting one if the port is free and
 * replacing one this session is strictly newer than.
 *
 * Never throws because the endpoint is down: reads work with no endpoint at
 * all, so a session that cannot start one still comes up and refuses writes
 * with a reason. The one hard error is a foreign listener on the port, which
 * is the same conflict the bind-if-free model reported.
 */
export async function ensureEndpoint(options: EnsureEndpointOptions): Promise<ResidentEndpoint> {
  const { host, port } = options;
  const ourVersion = options.ourVersion ?? SERVER_INFO.version;
  const endpoint = new ResidentEndpoint(host, port);
  const found = await probe(host, port);

  if (found.kind === "foreign") {
    throw new Error(
      `port ${port} on ${host} is held by something that is not an mlo-mcp sync endpoint (${found.detail}) — ` +
        "MLO's sync proxy points at that port, so free it (or set MLO_CLOUD_PORT and repoint the proxy) before " +
        "using this server",
    );
  }
  if (found.kind === "endpoint") {
    const theirVersion = found.status.version;
    if (theirVersion !== undefined && compareVersions(ourVersion, theirVersion) <= 0) {
      endpoint.adopt(found.status);
      return endpoint;
    }
    log(`resident endpoint on ${host}:${port} is ${theirVersion ?? "an older build"}; this session is ${ourVersion} — replacing it`);
    // A build too old to have /v1/shutdown refuses here. Waiting out the full
    // start timeout for a port it was never asked to release would stall every
    // session of a rollout, so a refusal ends the attempt immediately.
    const asked = await endpoint.requestShutdown().then(() => true, () => false);
    const freed = asked &&
      await waitFor(START_TIMEOUT_MS, async () => (await portIsTaken(host, port, PROBE_TIMEOUT_MS)) ? undefined : true);
    if (!freed) {
      log(`the endpoint on ${host}:${port} did not step aside — attaching to it instead of replacing it`);
      endpoint.adopt(found.status);
      return endpoint;
    }
  }

  await options.spawn();
  const started = await waitFor(options.startTimeoutMs ?? START_TIMEOUT_MS, () => readStatus(host, port));
  if (started) endpoint.adopt(started);
  else {
    log(
      `no resident sync endpoint came up on ${host}:${port} — reads still work, but MLO's sync has nowhere to ` +
        "connect and writes will be refused until one starts",
    );
  }
  return endpoint;
}

/**
 * How the resident is started: this package's own entry point, re-invoked with
 * RESIDENT_FLAG. Detached, silent and windowless so it survives the session
 * that happened to start it — the property the whole record exists to buy, and
 * the one most easily lost in a refactor.
 */
export function residentSpawnArgs(entry: string): { command: string; args: string[]; options: SpawnOptions } {
  return {
    command: process.execPath,
    args: [...process.execArgv, entry, RESIDENT_FLAG],
    options: { detached: true, stdio: "ignore", windowsHide: true },
  };
}

export function residentSpawner(entry: string): EndpointSpawner {
  return () => {
    const { command, args, options } = residentSpawnArgs(entry);
    const child = spawn(command, args, options);
    child.on("error", (error) => log(`could not start the resident sync endpoint: ${error.message}`));
    child.unref();
  };
}

/**
 * A session's handle on the resident endpoint. Every call is a fresh loopback
 * request: the resident can exit between two of them, and a stale "reachable"
 * flag would turn that into a write that reports success.
 */
export class ResidentEndpoint {
  private last?: EndpointStatus;

  constructor(readonly host: string, readonly port: number) {}

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** Version observed at the last successful probe, if any. */
  get version(): string | undefined {
    return this.last?.version;
  }

  get reachable(): boolean {
    return this.last !== undefined;
  }

  /** Internal: record what a probe found. */
  adopt(status: EndpointStatus): void {
    this.last = status;
  }

  /** Re-probe; undefined means nothing is serving the port right now. */
  async status(): Promise<EndpointStatus | undefined> {
    const status = await readStatus(this.host, this.port);
    this.last = status;
    return status;
  }

  /**
   * Ask a stale resident process to exit so a newer build can take the port.
   * Short timeout: a resident too wedged to answer is one the caller falls back
   * to attaching to, not one worth blocking a session's startup on.
   */
  async requestShutdown(): Promise<void> {
    await this.post("/v1/shutdown", {}, PROBE_TIMEOUT_MS);
  }

  private async post<T>(route: string, body: unknown, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.last = undefined;
      throw new Error(
        `the resident MLO sync endpoint at ${this.url} did not answer ` +
          `(${error instanceof Error ? error.message : String(error)}). ${ENDPOINT_RECOVERY}`,
      );
    }
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    if (!response.ok) {
      const reason = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(reason);
    }
    return payload as T;
  }
}

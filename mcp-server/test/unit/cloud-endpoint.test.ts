import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, ensureEndpoint, residentSpawnArgs, RESIDENT_FLAG } from "../../src/cloud/endpoint.js";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { SERVER_INFO } from "../../src/version.js";

/**
 * Endpoint lifecycle from a session's point of view: is one reachable, did we
 * have to start it, and did we replace a stale one. Nothing here asserts the
 * private shape of the spawn or the wire format between the two processes —
 * the spawner is injected, and what is observed is whether an endpoint answers.
 */

const handles: CloudServerHandle[] = [];
const dirs: string[] = [];
const others: http.Server[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop().catch(() => undefined)));
  await Promise.all(others.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-endpoint-"));
  dirs.push(dir);
  return dir;
}

/** A port nothing is listening on: bind one, read it back, release it. */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/** Stands in for the detached child: starts a real endpoint on the port. */
function inProcessSpawner(port: number, stateRoot: string): { spawn: () => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    spawn: async () => {
      calls.push(calls.length);
      const handle = await startCloudServer({ host: "127.0.0.1", port, stateRoot });
      handles.push(handle);
    },
  };
}

describe("ensureEndpoint", () => {
  it("starts the endpoint exactly once when none is running, then attaches to it", async () => {
    const port = await freePort();
    const spawner = inProcessSpawner(port, await root());

    const first = await ensureEndpoint({ host: "127.0.0.1", port, spawn: spawner.spawn });
    expect(first.reachable).toBe(true);
    expect(first.version).toBe(SERVER_INFO.version);
    expect(spawner.calls).toHaveLength(1);

    const second = await ensureEndpoint({ host: "127.0.0.1", port, spawn: spawner.spawn });
    expect(second.reachable).toBe(true);
    expect(spawner.calls).toHaveLength(1); // attached; nothing spawned
  });

  it("attaches without spawning when an endpoint of the same or a newer build already serves the port", async () => {
    const stateRoot = await root();
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateRoot });
    handles.push(handle);
    const spawner = inProcessSpawner(handle.port, stateRoot);

    const equal = await ensureEndpoint({ host: "127.0.0.1", port: handle.port, spawn: spawner.spawn });
    expect(equal.reachable).toBe(true);
    expect(spawner.calls).toHaveLength(0);

    // An OLDER session must not downgrade a newer resident process.
    const older = await ensureEndpoint({
      host: "127.0.0.1", port: handle.port, spawn: spawner.spawn, ourVersion: "0.0.1",
    });
    expect(older.reachable).toBe(true);
    expect(spawner.calls).toHaveLength(0);
    expect(handle.server.listening).toBe(true); // the original is still serving
  });

  it("replaces a stale endpoint when this session is strictly newer", async () => {
    // Distinct state roots make "which process is serving now" observable
    // without reaching into either one.
    const staleRoot = await root();
    const freshRoot = await root();
    const port = await freePort();
    const stale = await startCloudServer({ host: "127.0.0.1", port, stateRoot: staleRoot });
    handles.push(stale);
    const spawner = inProcessSpawner(port, freshRoot);

    const endpoint = await ensureEndpoint({
      host: "127.0.0.1", port, spawn: spawner.spawn, ourVersion: "999.0.0",
    });

    expect(spawner.calls).toHaveLength(1);
    expect(endpoint.reachable).toBe(true);
    expect(stale.server.listening).toBe(false); // the stale listener really did exit
    expect((await endpoint.status())?.stateRoot).toBe(freshRoot);
  });

  it("fails hard when the port is held by something that is not an mlo-mcp endpoint", async () => {
    const other = http.createServer((_request, response) => { response.writeHead(200); response.end("not mlo"); });
    others.push(other);
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const port = (other.address() as net.AddressInfo).port;
    const spawner = inProcessSpawner(port, await root());

    await expect(ensureEndpoint({ host: "127.0.0.1", port, spawn: spawner.spawn }))
      .rejects.toThrow(/not an mlo-mcp/i);
    expect(spawner.calls).toHaveLength(0);
  });

  it("fails hard when the port holder never answers at all, rather than living with a dead sync", async () => {
    // A raw socket, or a wedged process: nothing will ever spawn over it, so
    // MLO's sync would stay down forever if this were merely logged.
    const squatter = net.createServer((socket) => socket.resume());
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const port = (squatter.address() as net.AddressInfo).port;
    const spawner = inProcessSpawner(port, await root());
    try {
      await expect(ensureEndpoint({ host: "127.0.0.1", port, spawn: spawner.spawn }))
        .rejects.toThrow(/not an mlo-mcp/i);
      expect(spawner.calls).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("gives up at once on an endpoint too old to be asked to exit, instead of waiting out the timeout", async () => {
    // Every stale endpoint that exists today predates /v1/shutdown, so this is
    // the rollout path: it must attach immediately, not stall the session.
    const stale = http.createServer((request, response) => {
      if (request.url === "/v1/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ cursor: "0", entries: { mcp: 0, app: 0 }, pendingForApp: 0 }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
    others.push(stale);
    await new Promise<void>((resolve) => stale.listen(0, "127.0.0.1", resolve));
    const port = (stale.address() as net.AddressInfo).port;
    const spawner = inProcessSpawner(port, await root());

    const started = Date.now();
    const endpoint = await ensureEndpoint({ host: "127.0.0.1", port, spawn: spawner.spawn, ourVersion: "999.0.0" });

    expect(endpoint.reachable).toBe(true);
    expect(endpoint.version).toBeUndefined(); // a build from before version reporting
    expect(spawner.calls).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports an unreachable endpoint instead of throwing when one cannot be started", async () => {
    const port = await freePort();
    const endpoint = await ensureEndpoint({
      host: "127.0.0.1", port, spawn: () => undefined, startTimeoutMs: 300,
    });
    expect(endpoint.reachable).toBe(false);
    expect(endpoint.version).toBeUndefined();
    expect(await endpoint.status()).toBeUndefined();
  });

  it("spawns the resident detached, silent, and windowless so closing the session cannot kill it", () => {
    const args = residentSpawnArgs("C:\\install\\mlo-mcp.js");
    expect(args.args).toContain("C:\\install\\mlo-mcp.js");
    expect(args.args).toContain(RESIDENT_FLAG);
    expect(args.options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
  });
});

/** Which build wins the port is decided here, so the rule is pinned directly. */
describe("compareVersions", () => {
  it("orders releases numerically, segment by segment, and treats equals as equal", () => {
    expect(compareVersions("0.4.0", "0.3.9")).toBe(1);
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.3.0", "0.10.0")).toBe(-1); // not lexicographic
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.3", "0.3.0")).toBe(0); // missing segments are zero
    expect(compareVersions("0.4.0-rc.1", "0.3.0")).toBe(1); // prerelease sorts by its number
  });
});

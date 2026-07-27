import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { parseProblem, problemBody } from "../../src/cloud/problem.js";
import { HttpResidentClient } from "../../src/repo/resident-client.js";
import { LocalMloRepository } from "../../src/repo/local-mlo-repository.js";
import { WriteRefusedError } from "../../src/repo/mlo-repository.js";
import type { MloConfig } from "../../src/types.js";
import type { MloCli } from "../../src/repo/mlo-cli.js";
import { FakeResidentClient } from "../fakes/fake-resident-client.js";
import { describeResidentClientContract, sampleAddRows } from "../contract/resident-client-contract.js";

const UID = "{DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD}";
const PROFILE = "C:/profiles/resident-client.ml";

const handles: CloudServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-resident-client-"));
  dirs.push(dir);
  return dir;
}

async function boundGateway(stateRoot: string): Promise<CloudGateway> {
  const gateway = new CloudGateway({ stateRoot });
  await gateway.bindings.create(PROFILE, "upstream");
  await gateway.bindings.bindUid(PROFILE, UID);
  return gateway;
}

/** An ephemeral port nothing listens on (bound once, then released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

describeResidentClientContract("HTTP driver against a real resident", async () => {
  const gateway = await boundGateway(await tempRoot());
  const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
  handles.push(handle);
  return {
    client: new HttpResidentClient({ host: handle.host, port: handle.port }),
    boundProfile: PROFILE,
    downClient: async () => new HttpResidentClient({ host: "127.0.0.1", port: await freePort() }),
  };
});

describeResidentClientContract("fake", () => {
  const down = new FakeResidentClient();
  down.setDown(true);
  return {
    client: new FakeResidentClient(),
    boundProfile: PROFILE,
    downClient: () => down,
  };
});

describe("HttpResidentClient", () => {
  it("attaches lazily, spawning a resident on the call that needs it", async () => {
    const gateway = await boundGateway(await tempRoot());
    const port = await freePort();
    let spawned = 0;
    const client = new HttpResidentClient({
      host: "127.0.0.1",
      port,
      spawn: async () => {
        spawned += 1;
        handles.push(await startCloudServer({ host: "127.0.0.1", port, gateway, observeHost: "127.0.0.1" }));
      },
      startTimeoutMs: 5_000,
    });
    const result = await client.postWrite({ profile: PROFILE, rows: sampleAddRows() });
    expect(spawned).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("refuses partition-not-ready for a profile without a binding", async () => {
    const gateway = new CloudGateway({ stateRoot: await tempRoot() });
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
    handles.push(handle);
    const client = new HttpResidentClient({ host: handle.host, port: handle.port });
    const result = await client.postWrite({ profile: "C:/profiles/unbound.ml", rows: sampleAddRows() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.kind).toBe("partition-not-ready");
    expect(result.refusal.retryable).toBe("after-user-action");
    expect(result.refusal.remedy).toBeTruthy();
  });
});

describe("problem+json rehydration", () => {
  it("degrades an unrecognized type to kind unknown without losing it", () => {
    const rehydrated = parseProblem(422, problemBody({
      kind: "some-future-kind",
      title: "a kind this build has never heard of",
      retryable: true,
    }));
    expect(rehydrated.kind).toBe("unknown");
    expect(rehydrated.type).toBe("urn:mlo-mcp:some-future-kind");
    expect(rehydrated.title).toBe("a kind this build has never heard of");
    expect(rehydrated.retryable).toBe(true);
  });

  it("degrades a non-JSON body to kind unknown", () => {
    const rehydrated = parseProblem(500, "<html>proxy error</html>");
    expect(rehydrated.kind).toBe("unknown");
    expect(rehydrated.retryable).toBe(false);
  });

  it("carries a known kind's typed fields through as extensions", () => {
    const rehydrated = parseProblem(409, problemBody({
      kind: "partition-not-ready",
      title: "no binding",
      retryable: "after-user-action",
      remedy: "bootstrap",
      extensions: { profile: "C:/p.ml" },
    }));
    expect(rehydrated.kind).toBe("partition-not-ready");
    expect(rehydrated.retryable).toBe("after-user-action");
    expect(rehydrated.remedy).toBe("bootstrap");
    expect(rehydrated.extensions.profile).toBe("C:/p.ml");
  });

  it("a scripted unknown-type refusal reaches the fake's caller as kind unknown", async () => {
    const fake = new FakeResidentClient();
    fake.refuseNextWithRaw(500, JSON.stringify({ type: "urn:other-app:weird", title: "not ours", retryable: false }));
    const result = await fake.postWrite({ profile: PROFILE, rows: sampleAddRows() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.kind).toBe("unknown");
    expect(result.refusal.type).toBe("urn:other-app:weird");
  });
});

/** Reads are not under test here; only the write half of the repository is. */
const unusedCli: MloCli = {
  exportXml: () => Promise.reject(new Error("no reads in this test")),
  quickSync: () => Promise.resolve(),
  readDataFile: () => Promise.reject(new Error("no binary in this test")),
};

describe("LocalMloRepository write path", () => {
  function config(): MloConfig {
    return { dataFile: PROFILE, cacheStaleMs: 30_000 } as MloConfig;
  }

  it("write posts the profile's rows through the driver and returns the receipt", async () => {
    const resident = new FakeResidentClient();
    const repo = new LocalMloRepository(config(), unusedCli, resident);
    const pending = await repo.write(sampleAddRows());
    expect(pending.writeId).toBeTruthy();
    expect(resident.accepted[0]?.profile).toBe(PROFILE);
    expect(await repo.status(pending.writeId)).toBe("accepted");
    resident.transition(pending.writeId, "delivered");
    expect(await repo.status(pending.writeId)).toBe("delivered");
  });

  it("a driver refusal surfaces as the typed WriteRefusedError, never a spool", async () => {
    const resident = new FakeResidentClient();
    resident.setDown(true);
    const repo = new LocalMloRepository(config(), unusedCli, resident);
    const error = await repo.write(sampleAddRows()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WriteRefusedError);
    expect((error as WriteRefusedError).refusal.kind).toBe("endpoint-down");
    expect((error as WriteRefusedError).refusal.retryable).toBe(true);
    expect(resident.accepted).toHaveLength(0);
  });
});

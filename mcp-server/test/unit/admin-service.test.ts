import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminService } from "../../src/services/admin.js";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { ResidentEndpoint } from "../../src/cloud/endpoint.js";
import { FakeMloRepository } from "../fakes/fake-mlo-repository.js";
import type { MloConfig } from "../../src/types.js";
import { expectFailed, expectOk } from "../expect-result.js";

const UID = "{ABCDEF01-2345-6789-ABCD-EF0123456789}";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface Rig {
  admin: AdminService;
  gateway: CloudGateway;
  dataFile: string;
  /** The same cloud state, seen through a different resident endpoint. */
  withEndpoint(endpoint: ResidentEndpoint): AdminService;
}

async function rig(endpoint?: ResidentEndpoint): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-admin-"));
  dirs.push(root);
  const dataFile = path.join(root, "profile.ml");
  await fs.writeFile(dataFile, "the user's own data");
  const gateway = new CloudGateway({ stateRoot: path.join(root, "state") });
  await gateway.ensureRoot();
  const config = {
    mloExePath: "C:/mlo/mlo.exe",
    dataFile,
    exportDir: root,
    cacheStaleMs: 0,
    cloudHost: "127.0.0.1",
    cloudPort: 8181,
    cloudStateRoot: path.join(root, "state"),
  } satisfies MloConfig;
  const withEndpoint = (seen: ResidentEndpoint) =>
    new AdminService(config, new FakeMloRepository(), gateway, seen);
  return {
    admin: withEndpoint(endpoint ?? new ResidentEndpoint("127.0.0.1", 8181)),
    gateway,
    dataFile,
    withEndpoint,
  };
}

async function bind(gateway: CloudGateway, dataFile: string): Promise<void> {
  await gateway.bindings.create(dataFile, "upstream");
  await gateway.bindings.bindUid(dataFile, UID);
  await gateway.registry.open(UID, "upstream");
}

describe("AdminService.rebind", () => {
  it("backs the profile up before it drops the binding", async () => {
    const { admin, gateway, dataFile } = await rig();
    await bind(gateway, dataFile);

    const outcome = expectOk(await admin.rebind());

    expect(outcome.previousDataFileUID).toBe(UID);
    expect(await fs.readFile(outcome.backup, "utf8")).toBe("the user's own data");
    expect((await gateway.bindings.forProfile(dataFile))?.dataFileUID).toBeUndefined();
  });

  it("keeps the binding when the backup cannot be taken", async () => {
    const { admin, gateway, dataFile } = await rig();
    await bind(gateway, dataFile);
    await fs.rm(dataFile);

    const failure = expectFailed(await admin.rebind());
    expect(failure.kind).toBe("backup-failed");

    expect((await gateway.bindings.forProfile(dataFile))?.dataFileUID).toBe(UID);
  });

  it("leaves the old partition on disk as evidence", async () => {
    const { admin, gateway, dataFile } = await rig();
    await bind(gateway, dataFile);

    await admin.rebind();

    expect((await gateway.registry.list()).map((partition) => partition.dataFileUID)).toEqual([UID]);
  });
});

describe("AdminService.repull", () => {
  it("records the request against the bound partition without touching the binding", async () => {
    const { admin, gateway, dataFile } = await rig();
    await bind(gateway, dataFile);

    const outcome = expectOk(await admin.repull());

    expect(outcome.dataFileUID).toBe(UID);
    const partition = await gateway.registry.open(UID);
    expect(await partition.repullRequestedAt()).toBe(outcome.requestedAt);
    expect((await gateway.bindings.forProfile(dataFile))?.dataFileUID).toBe(UID);
  });

  it("surfaces the outstanding request in status", async () => {
    const { admin, gateway, dataFile } = await rig();
    await bind(gateway, dataFile);
    const { requestedAt } = expectOk(await admin.repull());

    expect(expectOk(await admin.status()).repullRequestedAt).toBe(requestedAt);
  });

  it("refuses when nothing is bound — there is no row store to refresh", async () => {
    const { admin } = await rig();

    const failure = expectFailed(await admin.repull());
    expect(failure.kind).toBe("partition-not-ready");
    expect(failure.detail).toMatch(/no bound cloud partition/);
  });
});

/** An endpoint that answers the probe without a process behind it. */
function endpointReporting(writesHeldOpen?: string[]): ResidentEndpoint {
  return {
    url: "http://127.0.0.1:8181",
    status: async () => ({ contactUids: [], ...(writesHeldOpen ? { writesHeldOpen } : {}) }),
  } as unknown as ResidentEndpoint;
}

describe("AdminService.status — the write aggregate", () => {
  it("is empty but present while the profile is unbound", async () => {
    const { admin } = await rig();
    expect(expectOk(await admin.status()).writes).toEqual({ pendingWrites: 0, recentDeadLetters: [] });
  });

  it("carries the last auto-init outcome, so an unbound profile says WHY it is unbound", async () => {
    const { admin, gateway } = await rig();
    await gateway.autoInitOutcome.record({
      kind: "refused",
      at: "2026-08-02T18:00:00.000Z",
      problem: { kind: "no-open-profile", title: "cannot tell which profile MLO has open", retryable: "after-user-action" },
    });

    expect(expectOk(await admin.status()).autoInit).toMatchObject({
      kind: "refused",
      problem: { kind: "no-open-profile" },
    });
  });

  it("omits autoInit while no attempt has been recorded", async () => {
    const { admin } = await rig();
    expect(expectOk(await admin.status()).autoInit).toBeUndefined();
  });

  it("counts the queue and ages the oldest write in it", async () => {
    const { admin, gateway, dataFile } = await rig();
    await bind(gateway, dataFile);
    const partition = await gateway.registry.open(UID, "upstream");
    const queuedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await partition.queue.enqueue({
      writeId: "w1",
      uid: UID,
      verb: "add",
      rows: [{ section: "TodoItems", values: [] }],
      queuedAt,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    const { writes } = expectOk(await admin.status());
    expect(writes.pendingWrites).toBe(1);
    expect(writes.oldestPendingAgeMs).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("carries the recent dead letters newest first, with uid, caption and reason", async () => {
    const { admin, gateway, dataFile } = await rig();
    await bind(gateway, dataFile);
    const partition = await gateway.registry.open(UID, "upstream");
    // Delivered writes are not dead letters: only the two that lost their rows.
    await partition.outcomes.record({ writeId: "w0", uid: UID, verb: "add", status: "delivered", at: "2026-07-27T09:00:00Z" });
    await partition.outcomes.record({
      writeId: "w1", uid: UID, verb: "update", caption: "call the dentist", status: "expired",
      at: "2026-07-27T10:00:00Z", detail: "MLO did not apply the row before 10:00",
    });
    await partition.outcomes.record({
      writeId: "w2", uid: UID, verb: "complete", caption: "file taxes", status: "superseded",
      at: "2026-07-27T11:00:00Z", detail: "MLO uploaded its own row for the same UID",
    });

    const { recentDeadLetters } = expectOk(await admin.status()).writes;
    expect(recentDeadLetters.map((dead) => dead.writeId)).toEqual(["w2", "w1"]);
    expect(recentDeadLetters[0]).toMatchObject({ uid: UID, caption: "file taxes", status: "superseded" });
    expect(recentDeadLetters[0]!.reason).toMatch(/its own row/);
  });

  it("reports sessionHeldOpen from the endpoint, and stays silent when it cannot say", async () => {
    // One cloud state, three endpoints: the gauge is the endpoint's answer, so
    // that is the only thing that varies.
    const { gateway, dataFile, withEndpoint } = await rig();
    await bind(gateway, dataFile);

    const held = withEndpoint(endpointReporting(["w1"]));
    expect(expectOk(await held.status()).writes.sessionHeldOpen).toBe(true);

    const quiet = withEndpoint(endpointReporting([]));
    expect(expectOk(await quiet.status()).writes.sessionHeldOpen).toBe(false);

    // An endpoint too old to report it, or unreachable: unknown, never "no".
    const silent = withEndpoint(endpointReporting());
    expect(expectOk(await silent.status()).writes.sessionHeldOpen).toBeUndefined();
  });
});

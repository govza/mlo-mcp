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
}

async function rig(): Promise<Rig> {
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
  const admin = new AdminService(config, new FakeMloRepository(), gateway, new ResidentEndpoint("127.0.0.1", 8181));
  return { admin, gateway, dataFile };
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

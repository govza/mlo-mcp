import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutoInitializer,
  groundTruthVerdict,
  type AutoInitPorts,
  type PulledHistory,
} from "../../src/cloud/auto-init.js";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { buildTaskAddDelta } from "../../src/cloud/delta.js";
import { packEnvelope } from "../../src/cloud/envelope.js";
import type { VendorContact } from "../../src/cloud/upstream.js";

/**
 * The auto-init pull suite (spec section 8): every stage of pull → validate →
 * ground-truth → materialize is fault-injected in turn, and the assertion is
 * always the same one — no binding was written.
 */

const PROFILE = "C:/profiles/auto-init.ml";
const UID = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";
const OTHER_UID = "{11111111-1111-1111-1111-111111111111}";
const TASK = "{22222222-3333-4444-5555-666666666666}";
const FOREIGN_TASK = "{99999999-9999-9999-9999-999999999999}";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-auto-init-"));
  dirs.push(dir);
  return dir;
}

const contact: VendorContact = {
  target: new URL("http://sync.example.test/MLOInetSync.asmx"),
  loginBytes: "login",
  passwordBytes: "password",
  seenAt: 0,
};

function history(uids: readonly string[] = [TASK]): PulledHistory {
  const document = buildTaskAddDelta({
    uid: uids[0] ?? TASK,
    caption: "pulled task",
    createdDate: "2026-07-01T09:00:00",
    lastModified: "2026-07-01T09:00:00",
  });
  const tasks = document.sections.find((section) => section.name === "TodoItems")!;
  const template = tasks.rows[0]!;
  const uidColumn = tasks.header.indexOf("UID");
  tasks.rows = uids.map((uid) => template.map((cell, index) => (index === uidColumn ? uid : cell)));
  return { version: "4321", envelope: Buffer.from(packEnvelope(document)) };
}

interface Rig {
  root: string;
  gateway: CloudGateway;
  autoInit: AutoInitializer;
  calls: { pulls: string[] };
}

async function rig(overrides: Partial<AutoInitPorts> = {}, options: { candidates?: string[] } = {}): Promise<Rig> {
  const root = await tempRoot();
  const gateway = new CloudGateway({ stateRoot: root });
  await gateway.ensureRoot();
  for (const uid of options.candidates ?? [UID]) gateway.noteVendorContact(uid, contact);
  const calls = { pulls: [] as string[] };
  const ports: AutoInitPorts = {
    openProfile: async () => PROFILE,
    localTaskGuids: async () => [TASK],
    pullHistory: async (uid) => { calls.pulls.push(uid); return history(); },
    ...overrides,
  };
  return { root, gateway, autoInit: new AutoInitializer(gateway, ports), calls };
}

async function boundUid(gateway: CloudGateway): Promise<string | undefined> {
  return (await gateway.bindings.forProfile(PROFILE))?.dataFileUID;
}

describe("guarded auto-initialization", () => {
  it("binds when all three guards pass, and seeds the row store from the pull", async () => {
    const { gateway, autoInit } = await rig();

    const result = await autoInit.attempt();

    expect(result).toMatchObject({ kind: "bound", dataFileUID: UID, profilePath: PROFILE, version: "4321" });
    expect(await boundUid(gateway)).toBe(UID);
    const partition = (await gateway.boundPartition(PROFILE)) as { partition: import("../../src/cloud/partition.js").PartitionStore };
    expect(await partition.partition.rows.size()).toBe(1);
    expect(await partition.partition.lifecycle()).toBe("ready");
    expect(await partition.partition.rows.latest(TASK)).toMatchObject({ kind: "row", source: "history-pull" });
  });

  it("is idempotent: a second attempt on a bound profile makes no vendor call", async () => {
    const { autoInit, calls } = await rig();
    await autoInit.attempt();

    const again = await autoInit.attempt();

    expect(again).toMatchObject({ kind: "already-bound", dataFileUID: UID });
    expect(calls.pulls).toEqual([UID]);
  });

  it("probes nothing once every cloud file it has seen is bound", async () => {
    let probes = 0;
    const { autoInit } = await rig({ openProfile: async () => { probes += 1; return PROFILE; } });
    await autoInit.attempt();
    const afterBinding = probes;

    await autoInit.attempt();

    // The steady state is one bound cloud file syncing over and over, and this
    // runs after every one of those sessions: a probe per sync would be a
    // PowerShell process per sync, spent to learn nothing.
    expect(probes).toBe(afterBinding);
  });

  it("refuses without an open profile, naming the guard", async () => {
    const { gateway, autoInit } = await rig({ openProfile: async () => undefined });

    const result = await autoInit.attempt();

    expect(result).toMatchObject({ kind: "refused", problem: { kind: "no-open-profile" } });
    expect(await boundUid(gateway)).toBeUndefined();
  });

  it("refuses to move an existing binding when a different cloud file syncs", async () => {
    const { gateway, autoInit } = await rig();
    await gateway.bindings.create(PROFILE, "upstream");
    await gateway.bindings.bindUid(PROFILE, OTHER_UID);

    const result = await autoInit.attempt();

    expect(result).toMatchObject({ kind: "refused", problem: { kind: "binding-conflict" } });
    expect(await boundUid(gateway)).toBe(OTHER_UID);
  });

  it("refuses with no candidate at all", async () => {
    const { gateway, autoInit, calls } = await rig({}, { candidates: [] });

    const result = await autoInit.attempt();

    expect(result).toMatchObject({ kind: "refused", problem: { kind: "no-bootstrap-candidate" } });
    expect(calls.pulls).toEqual([]);
    expect(await boundUid(gateway)).toBeUndefined();
  });

  it("refuses when two unbound cloud files have synced through the proxy", async () => {
    const { gateway, autoInit, calls } = await rig({}, { candidates: [UID, OTHER_UID] });

    const result = await autoInit.attempt();

    expect(result).toMatchObject({ kind: "refused", problem: { kind: "ambiguous-bootstrap-candidate" } });
    expect(calls.pulls).toEqual([]);
    expect(await boundUid(gateway)).toBeUndefined();
  });

  it("ignores a candidate another profile already claims", async () => {
    const { gateway, autoInit } = await rig({}, { candidates: [UID, OTHER_UID] });
    await gateway.bindings.create("C:/profiles/other.ml", "upstream");
    await gateway.bindings.bindUid("C:/profiles/other.ml", OTHER_UID);

    expect(await autoInit.attempt()).toMatchObject({ kind: "bound", dataFileUID: UID });
  });
});

describe("the auto-init pull, stage by stage", () => {
  it("writes no binding when the pull itself fails", async () => {
    const { gateway, autoInit } = await rig({
      pullHistory: async () => { throw new Error("vendor GetModificationsBytesEx failed with HTTP 500"); },
    });

    const result = await autoInit.attempt();

    expect(result).toMatchObject({ kind: "refused", problem: { kind: "auto-init-pull-failed", retryable: true } });
    expect(await boundUid(gateway)).toBeUndefined();
  });

  it("writes no binding when the pulled payload does not validate", async () => {
    const { gateway, autoInit } = await rig({
      pullHistory: async () => ({ version: "1", envelope: Buffer.from("not a history at all") }),
    });

    const result = await autoInit.attempt();

    expect(result).toMatchObject({ kind: "refused", problem: { kind: "auto-init-pull-failed" } });
    expect(await boundUid(gateway)).toBeUndefined();
  });

  it("writes no binding when the history ground-truths against a different profile", async () => {
    const { gateway, autoInit } = await rig({ localTaskGuids: async () => [FOREIGN_TASK] });

    const result = await autoInit.attempt();

    expect(result).toMatchObject({ kind: "refused", problem: { kind: "candidate-not-ground-truthed" } });
    expect(await boundUid(gateway)).toBeUndefined();
  });

  it("writes no binding when materializing the row store fails, and says so", async () => {
    const { gateway, autoInit } = await rig();
    const partition = await gateway.registry.open(UID, "upstream");
    partition.rows.replaceAll = async () => { throw new Error("rows.json is not writable"); };

    const result = await autoInit.attempt();

    // Named for the stage that failed, not folded into the pull's kind: a
    // local write fault and a vendor fault have nothing in common but timing.
    expect(result).toMatchObject({ kind: "refused", problem: { kind: "auto-init-materialize-failed" } });
    expect(await boundUid(gateway)).toBeUndefined();
  });

  it("still binds when the open data file cannot be read — an absent signal refutes nothing", async () => {
    const { gateway, autoInit } = await rig({
      localTaskGuids: async () => { throw new Error("EBUSY: the app holds the file"); },
    });

    expect(await autoInit.attempt()).toMatchObject({ kind: "bound" });
    expect(await boundUid(gateway)).toBe(UID);
  });
});

describe("ground-truthing a candidate", () => {
  it("accepts any overlap at all", () => {
    expect(groundTruthVerdict([TASK, FOREIGN_TASK], [TASK])).toMatchObject({ ok: true, overlap: 1 });
  });

  it("refutes two non-empty sets of task identities with nothing in common", () => {
    expect(groundTruthVerdict([FOREIGN_TASK], [TASK])).toMatchObject({ ok: false });
  });

  it("never refutes on an empty side, from either direction", () => {
    expect(groundTruthVerdict([], [TASK])).toMatchObject({ ok: true });
    expect(groundTruthVerdict([TASK], [])).toMatchObject({ ok: true });
  });
});

describe("repull", () => {
  it("refreshes the row store and clears the request without touching the binding", async () => {
    const { gateway, autoInit } = await rig();
    await autoInit.attempt();
    const partition = await gateway.registry.open(UID, "upstream");
    await partition.requestRepull();

    const result = await autoInit.servicePendingRepull(partition);

    expect(result).toMatchObject({ kind: "repulled", tasks: 1 });
    expect(await partition.repullRequestedAt()).toBeUndefined();
    expect(await boundUid(gateway)).toBe(UID);
  });

  it("does nothing when none was requested", async () => {
    const { gateway, autoInit } = await rig();
    await autoInit.attempt();
    const partition = await gateway.registry.open(UID, "upstream");

    expect(await autoInit.servicePendingRepull(partition)).toEqual({ kind: "none" });
  });

  it("leaves the request standing when the pull fails, so the next sync retries it", async () => {
    let fail = true;
    const { gateway, autoInit } = await rig({
      pullHistory: async () => {
        if (fail) throw new Error("vendor unreachable");
        return history();
      },
    });
    fail = false;
    await autoInit.attempt();
    const partition = await gateway.registry.open(UID, "upstream");
    await partition.requestRepull();
    fail = true;

    const result = await autoInit.servicePendingRepull(partition);

    expect(result).toMatchObject({ kind: "failed", problem: { kind: "auto-init-pull-failed" } });
    expect(await partition.repullRequestedAt()).toBeDefined();
    expect(await boundUid(gateway)).toBe(UID);
  });
});

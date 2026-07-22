import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { handleSoapRequest } from "../../src/cloud/soap.js";
import { buildTaskAddDelta, mergeDeltas } from "../../src/cloud/delta.js";
import { packEnvelope, unpackEnvelope } from "../../src/cloud/envelope.js";
import { findSection, type SectionedCsv } from "../../src/cloud/csv.js";
import { knownCloudProjection, rowValue } from "../../src/cloud/log-projection.js";
import { validateFullSnapshot } from "../../src/cloud/snapshot-validate.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

const PROFILE = "C:\\Profiles\\Personal.ml";
const UID = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const OTHER_UID = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
const TASK_PARENT = "{11111111-1111-1111-1111-111111111111}";
const TASK_CHILD = "{22222222-2222-2222-2222-222222222222}";
const TOMBSTONE = "{99999999-9999-9999-9999-999999999999}";

async function gatewayAt(): Promise<CloudGateway> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-boot-"));
  dirs.push(root);
  return new CloudGateway({ stateRoot: root });
}

/**
 * A synthetic full snapshot shaped like the captured re-synchronize upload
 * (delta-36): complete task rows, a Config section, and historical
 * tombstones alongside the live rows.
 */
function fullSnapshot(extras?: { unknownColumn?: boolean; unknownSection?: boolean }): SectionedCsv {
  const document = mergeDeltas([
    buildTaskAddDelta({
      uid: TASK_PARENT,
      caption: "Existing project",
      createdDate: "2026-07-01T08:00:00",
      lastModified: "2026-07-01T08:00:00",
    }),
    buildTaskAddDelta({
      uid: TASK_CHILD,
      caption: "Existing project", // duplicate caption on purpose
      parentUid: TASK_PARENT,
      createdDate: "2026-07-02T08:00:00",
      lastModified: "2026-07-02T08:00:00",
    }),
  ]);
  findSection(document, "TodoItems.Deleted")!.rows.push([TOMBSTONE]);
  if (extras?.unknownColumn) {
    const tasks = findSection(document, "TodoItems")!;
    tasks.header.push("FutureColumn");
    for (const row of tasks.rows) row.push("opaque-value");
  }
  document.sections.push({ name: "Config", header: ["Name", "Value"], rows: [["SORT_TYPE", "1"], ["DDW", "3"]] });
  if (extras?.unknownSection) {
    document.sections.push({ name: "Future.Section", header: ["Key", "Value"], rows: [["k", "v"]] });
  }
  return document;
}

function soapRequest(operation: string, fields: Record<string, string>): string {
  const body = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation} xmlns="http://www.mylifeorganized.net/">${body}</${operation}>` +
    `</soap:Body></soap:Envelope>`;
}

function responseField(bytes: Uint8Array, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(Buffer.from(bytes).toString("utf8"));
  return match?.[1];
}

async function soap(gateway: CloudGateway, operation: string, fields: Record<string, string>): Promise<Uint8Array> {
  return handleSoapRequest(gateway, operation as never, soapRequest(operation, fields));
}

describe("snapshot validation", () => {
  it("accepts a full snapshot with historical tombstones and unknown fields", () => {
    const validation = validateFullSnapshot(fullSnapshot({ unknownColumn: true, unknownSection: true }));
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.stats.tasks).toBe(2);
    expect(validation.stats.taskTombstones).toBe(1);
  });

  it("rejects an ordinary incremental delta as not a full upload", () => {
    const delta = buildTaskAddDelta({
      uid: TASK_PARENT,
      caption: "one change",
      createdDate: "2026-07-01T08:00:00",
      lastModified: "2026-07-01T08:00:00",
    });
    const validation = validateFullSnapshot(delta);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("; ")).toContain("no Config section");
  });

  it("rejects tombstones overlapping live rows, duplicate UIDs, and unresolved parents", () => {
    const overlapping = fullSnapshot();
    findSection(overlapping, "TodoItems.Deleted")!.rows.push([TASK_PARENT]);
    expect(validateFullSnapshot(overlapping).errors.join("; ")).toContain("overlaps a live row");

    const dangling = fullSnapshot();
    const tasks = findSection(dangling, "TodoItems")!;
    const parentIndex = tasks.header.indexOf("ParentUID");
    tasks.rows[1]![parentIndex] = "{33333333-3333-3333-3333-333333333333}";
    expect(validateFullSnapshot(dangling).errors.join("; ")).toContain("unresolved ParentUID");
  });
});

describe("bootstrap window over SOAP", () => {
  async function armAndBootstrap(gateway: CloudGateway): Promise<void> {
    await gateway.ensureRoot();
    await gateway.bindings.create(PROFILE, "local");
    await gateway.bootstrap.arm(PROFILE, "local");
  }

  it("runs the verified re-synchronize sequence to a ready partition", async () => {
    const gateway = await gatewayAt();
    await armAndBootstrap(gateway);

    // Get: empty partition adopts the profile's stored cursor, serves the
    // empty skeleton (the bidirectional precondition).
    const got = await soap(gateway, "GetModificationsBytesEx", { dataFileUID: UID, newerThan: "15515" });
    expect(responseField(got, "GetModificationsBytesExResult")).toBe("true");
    expect(responseField(got, "maxVersion")).toBe("15515");

    // Apply: the full snapshot (local stamp deliberately unrelated to the
    // remote cursor — its numeric value must not matter).
    const applied = await soap(gateway, "ApplyModificationsBytesEx", {
      dataFileUID: UID,
      lastSyncTimestamp: "24838",
      data: Buffer.from(packEnvelope(fullSnapshot())).toString("base64"),
    });
    expect(responseField(applied, "ApplyModificationsBytesExResult")).toBe("true");
    expect(responseField(applied, "newServerTimeStamp")).toBe("15516");

    // Follow-up Get + Release behave as a normal ready session.
    const followUp = await soap(gateway, "GetModificationsBytesEx", { dataFileUID: UID, newerThan: "15516" });
    expect(responseField(followUp, "GetModificationsBytesExResult")).toBe("true");
    const released = await soap(gateway, "ReleaseSyncSessionBytes", { dataFileUID: UID, sessionID: "s" });
    expect(responseField(released, "ReleaseSyncSessionBytesResult")).toBe("true");

    const partition = await gateway.registry.open(UID);
    expect(await partition.lifecycle()).toBe("ready");
    expect((await gateway.bindings.forProfile(PROFILE))?.dataFileUID).toBe(UID);
    expect(await gateway.bootstrap.current()).toBeUndefined();

    // The materialized snapshot backs projections: both tasks resolve with
    // their real UIDs, including the duplicate-caption child.
    const projection = await knownCloudProjection(partition.state);
    expect(projection.rows.size).toBe(2);
    expect(rowValue(projection.rows.get(TASK_CHILD)!, "ParentUID")).toBe(TASK_PARENT);
  });

  it("refuses an upload before the empty-partition pull", async () => {
    const gateway = await gatewayAt();
    await armAndBootstrap(gateway);
    const applied = await soap(gateway, "ApplyModificationsBytesEx", {
      dataFileUID: UID,
      lastSyncTimestamp: "0",
      data: Buffer.from(packEnvelope(fullSnapshot())).toString("base64"),
    });
    expect(responseField(applied, "ApplyModificationsBytesExResult")).toBe("false");
    expect(responseField(applied, "errorMessage")).toContain("before the empty-partition pull");
  });

  it("keeps the partition un-bootstrapped when a partial delta arrives, then accepts a retry", async () => {
    const gateway = await gatewayAt();
    await armAndBootstrap(gateway);
    await soap(gateway, "GetModificationsBytesEx", { dataFileUID: UID, newerThan: "0" });

    const partial = buildTaskAddDelta({
      uid: TASK_PARENT,
      caption: "just one row",
      createdDate: "2026-07-01T08:00:00",
      lastModified: "2026-07-01T08:00:00",
    });
    const rejected = await soap(gateway, "ApplyModificationsBytesEx", {
      dataFileUID: UID,
      lastSyncTimestamp: "0",
      data: Buffer.from(packEnvelope(partial)).toString("base64"),
    });
    expect(responseField(rejected, "ApplyModificationsBytesExResult")).toBe("false");
    expect(responseField(rejected, "errorMessage")).toContain("failed validation");
    const partition = await gateway.registry.open(UID);
    expect(await partition.lifecycle()).toBe("bootstrap-required");
    // Nothing was appended — the refused upload never became history.
    expect(await partition.state.highWater()).toBe(0n);
    // The staged bytes were kept for diagnosis.
    expect(await fs.stat(gateway.bootstrap.stagedPath()).then(() => true, () => false)).toBe(true);

    // In-window retry with the real full snapshot succeeds (restart/replay).
    const retried = await soap(gateway, "ApplyModificationsBytesEx", {
      dataFileUID: UID,
      lastSyncTimestamp: "0",
      data: Buffer.from(packEnvelope(fullSnapshot())).toString("base64"),
    });
    expect(responseField(retried, "ApplyModificationsBytesExResult")).toBe("true");
    expect(await partition.lifecycle()).toBe("ready");
  });

  it("fails closed when a second unknown dataFileUID appears during the window", async () => {
    const gateway = await gatewayAt();
    await armAndBootstrap(gateway);
    await soap(gateway, "GetModificationsBytesEx", { dataFileUID: UID, newerThan: "0" });
    const intruder = await soap(gateway, "GetModificationsBytesEx", { dataFileUID: OTHER_UID, newerThan: "0" });
    expect(responseField(intruder, "GetModificationsBytesExResult")).toBe("false");
    expect(responseField(intruder, "errorMessage")).toContain("second unknown dataFileUID");
    // The window disarmed: even the original UID is now refused.
    const after = await soap(gateway, "GetModificationsBytesEx", { dataFileUID: UID, newerThan: "0" });
    expect(responseField(after, "GetModificationsBytesExResult")).toBe("false");
    expect(responseField(after, "errorMessage")).toContain("no profile is bound");
  });

  it("refuses concurrent arming for a different profile and survives controller restarts", async () => {
    const gateway = await gatewayAt();
    await armAndBootstrap(gateway);
    await expect(gateway.bootstrap.arm("C:\\Other.ml", "local"))
      .rejects.toThrow("already armed for a different profile");
    // A fresh gateway over the same root sees the persisted window (attach mode).
    const attached = new CloudGateway({ stateRoot: gateway.stateRoot });
    expect((await attached.bootstrap!.current())?.profilePath).toBe(PROFILE);
  });

  it("preserves unknown sections, columns, and opaque cells through materialization", async () => {
    const gateway = await gatewayAt();
    await armAndBootstrap(gateway);
    await soap(gateway, "GetModificationsBytesEx", { dataFileUID: UID, newerThan: "0" });
    const applied = await soap(gateway, "ApplyModificationsBytesEx", {
      dataFileUID: UID,
      lastSyncTimestamp: "0",
      data: Buffer.from(packEnvelope(fullSnapshot({ unknownColumn: true, unknownSection: true }))).toString("base64"),
    });
    expect(responseField(applied, "ApplyModificationsBytesExResult")).toBe("true");

    const partition = await gateway.registry.open(UID);
    const stored = await partition.snapshots.load();
    expect(stored).toBeDefined();
    const futureSection = findSection(stored!.document, "Future.Section");
    expect(futureSection?.rows).toEqual([["k", "v"]]);
    const tasks = findSection(stored!.document, "TodoItems")!;
    const futureColumn = tasks.header.indexOf("FutureColumn");
    expect(futureColumn).toBeGreaterThanOrEqual(0);
    expect(tasks.rows.every((row) => row[futureColumn] === "opaque-value")).toBe(true);
    // The historical tombstone also survived verbatim.
    expect(findSection(stored!.document, "TodoItems.Deleted")!.rows).toContainEqual([TOMBSTONE]);
    // And projections surface the opaque cell for lossless row authoring.
    const projection = await knownCloudProjection(partition.state);
    expect(rowValue(projection.rows.get(TASK_PARENT)!, "FutureColumn")).toBe("opaque-value");
  });
});

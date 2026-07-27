import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { PartitionRegistry } from "../../src/cloud/partition.js";
import {
  describeWriteRows,
  nudgedFileTsVersion,
  presentedGetVersion,
  rowsMatch,
  WritePath,
} from "../../src/cloud/write-path.js";
import {
  buildTaskAddDelta,
  buildTaskDeleteDelta,
  deltaRowsFromDocument,
  documentFromDeltaRows,
  TODO_ITEMS_HEADER,
} from "../../src/cloud/delta.js";
import { packEnvelope, unpackEnvelope } from "../../src/cloud/envelope.js";
import { peekSoapResponseFields, soapFieldText } from "../../src/cloud/soap.js";
import { harvestTaskRows } from "../../src/cloud/row-store.js";
import type { ForwardResult } from "../../src/cloud/upstream.js";
import type { SectionedCsv } from "../../src/cloud/csv.js";
import type { DeltaRow } from "../../src/repo/mlo-repository.js";

const UID = "{ABABABAB-ABAB-ABAB-ABAB-ABABABABABAB}";
const TASK = "{11111111-2222-3333-4444-555555555555}";
const PROFILE = "C:/profiles/write-path.ml";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-write-path-"));
  dirs.push(dir);
  return dir;
}

interface Rig {
  root: string;
  gateway: CloudGateway;
  writePath: WritePath;
  clock: { now: Date };
}

async function boundRig(options: { ttlMs?: number } = {}): Promise<Rig> {
  const root = await tempRoot();
  const gateway = new CloudGateway({ stateRoot: root });
  await gateway.bindings.create(PROFILE, "upstream");
  await gateway.bindings.bindUid(PROFILE, UID);
  const clock = { now: new Date("2026-07-27T10:00:00Z") };
  const writePath = new WritePath(gateway, {
    ttlMs: options.ttlMs ?? 15 * 60_000,
    now: () => clock.now,
  });
  return { root, gateway, writePath, clock };
}

function addRows(uid = TASK, caption = "injected task"): DeltaRow[] {
  return deltaRowsFromDocument(buildTaskAddDelta({
    uid,
    caption,
    createdDate: "2026-07-27T09:00:00",
    lastModified: "2026-07-27T09:00:00",
  }));
}

function soapResult(operation: string, fields: string): ForwardResult {
  const xml = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation}Response xmlns="http://www.mylifeorganized.net/">${fields}</${operation}Response>` +
    `</soap:Body></soap:Envelope>`;
  return { status: 200, headers: { "content-type": "text/xml; charset=utf-8" }, body: Buffer.from(xml) };
}

function vendorGetResult(maxVersion: string, document?: SectionedCsv): ForwardResult {
  const data = document ? Buffer.from(packEnvelope(document)).toString("base64") : "";
  return soapResult("GetModificationsBytesEx",
    `<GetModificationsBytesExResult>true</GetModificationsBytesExResult>` +
    `<maxVersion>${maxVersion}</maxVersion>` + (data ? `<data>${data}</data>` : ""));
}

function applyRequestFields(session: string, document: SectionedCsv): Record<string, unknown> {
  return {
    dataFileUID: UID,
    sessionID: session,
    data: Buffer.from(packEnvelope(document)).toString("base64"),
  };
}

function applyResult(accepted: boolean, newServerTimeStamp?: string): ForwardResult {
  return soapResult("ApplyModificationsBytesEx",
    `<ApplyModificationsBytesExResult>${accepted}</ApplyModificationsBytesExResult>` +
    (newServerTimeStamp ? `<newServerTimeStamp>${newServerTimeStamp}</newServerTimeStamp>` : ""));
}

function fileTsResult(version: string): ForwardResult {
  return soapResult("GetFileTS", `<GetFileTSResult>${version}</GetFileTSResult>`);
}

function getFields(session: string, newerThan: string): Record<string, unknown> {
  return { dataFileUID: UID, sessionID: session, newerThan };
}

/** The injected payload MLO would re-export verbatim (delivery), or edited (supersede). */
function reExportOf(rows: DeltaRow[], patch: Record<string, string> = {}): SectionedCsv {
  const document = documentFromDeltaRows(rows.map((row) => ({ ...row, values: [...row.values] })));
  const tasks = document.sections.find((section) => section.name === "TodoItems")!;
  for (const row of tasks.rows) {
    for (const [column, value] of Object.entries(patch)) {
      row[tasks.header.indexOf(column)] = value;
    }
  }
  return document;
}

describe("version presentation (pure)", () => {
  it("rides the vendor's own advance, bumps past the stored cursor otherwise", () => {
    expect(presentedGetVersion(150n, 100n)).toBe(150n);
    expect(presentedGetVersion(100n, 100n)).toBe(101n);
    expect(presentedGetVersion(90n, 100n)).toBe(101n);
  });

  it("nudges GetFileTS past the last observed stored cursor, or past the vendor when unknown", () => {
    expect(nudgedFileTsVersion(147n, 147n)).toBe(148n);
    expect(nudgedFileTsVersion(147n, undefined)).toBe(148n);
    expect(nudgedFileTsVersion(147n, 150n)).toBe(151n); // bump survived an abort
    expect(nudgedFileTsVersion(200n, 150n)).toBe(200n); // vendor already ahead — verbatim suffices
  });
});

describe("describeWriteRows", () => {
  it("labels the four verbs off the rows alone", () => {
    expect(describeWriteRows(addRows())).toMatchObject({ uid: TASK, verb: "add", caption: "injected task" });
    const updated = addRows();
    const task = updated.find((row) => row.section === "TodoItems")!;
    task.values[TODO_ITEMS_HEADER.indexOf("LastModified")] = "2026-07-27T09:30:00";
    expect(describeWriteRows(updated)?.verb).toBe("update");
    task.values[TODO_ITEMS_HEADER.indexOf("CompletionDateTime")] = "2026-07-27T09:31:00";
    expect(describeWriteRows(updated)?.verb).toBe("complete");
    expect(describeWriteRows(deltaRowsFromDocument(buildTaskDeleteDelta([TASK]))))
      .toEqual({ uid: TASK, verb: "delete" });
  });

  it("refuses rows without a GUID-shaped task identity", () => {
    expect(describeWriteRows([{ section: "Places", values: ["x"] }])).toBeUndefined();
    expect(describeWriteRows([{ section: "TodoItems", values: ["not-a-guid"] }])).toBeUndefined();
  });
});

describe("rowsMatch", () => {
  const injected = { header: ["UID", "Caption", "LastModified", "ItemIndex"], cells: [TASK, "mine", "t1", "100"] };

  it("ignores the volatile columns MLO restamps", () => {
    expect(rowsMatch(injected, { header: ["UID", "Caption", "LastModified", "ItemIndex"], cells: [TASK, "mine", "t2", "350"] })).toBe(true);
  });

  it("treats a missing column and a blank value as the same", () => {
    expect(rowsMatch(injected, { header: ["UID", "Caption", "Note"], cells: [TASK, "mine", ""] })).toBe(true);
  });

  it("flags real content drift — the local-wins conflict signature", () => {
    expect(rowsMatch(injected, { header: ["UID", "Caption"], cells: [TASK, "the user's caption"] })).toBe(false);
  });
});

describe("delta row conversion", () => {
  it("round-trips a document through seam rows", () => {
    const rows = addRows();
    const rebuilt = deltaRowsFromDocument(documentFromDeltaRows(rows));
    expect(rebuilt).toEqual(rows);
  });

  it("refuses rows for unknown sections or with more values than columns", () => {
    expect(() => documentFromDeltaRows([{ section: "NotASection", values: [] }])).toThrow(/unknown delta section/);
    expect(() => documentFromDeltaRows([{ section: "TodoItems.Deleted", values: [TASK, "extra"] }]))
      .toThrow(/canonical columns/);
  });
});

describe("durable accept", () => {
  it("kill-after-accept preserves the row: a fresh process over the same root sees it", async () => {
    const rig = await boundRig();
    const outcome = await rig.writePath.accept(PROFILE, addRows());
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;

    // "kill" the resident: everything in memory is gone, only the disk remains
    const rebornPartition = await new PartitionRegistry(rig.root).open(UID);
    const pending = await rebornPartition.queue.pending();
    expect(pending.map((write) => write.writeId)).toEqual([outcome.writeId]);
    expect(pending[0]!.rows).toEqual(addRows());
  });

  it("refuses malformed rows and unbound profiles with typed problems", async () => {
    const rig = await boundRig();
    const empty = await rig.writePath.accept(PROFILE, []);
    expect(empty).toMatchObject({ kind: "refused", httpStatus: 400, problem: { kind: "invalid-request" } });
    const unbound = await rig.writePath.accept("C:/profiles/other.ml", addRows());
    expect(unbound).toMatchObject({
      kind: "refused",
      httpStatus: 409,
      problem: { kind: "partition-not-ready", retryable: "after-user-action" },
    });
  });
});

describe("Get injection", () => {
  it("injects pending rows for the bound UID, presenting vendorVersion + 1", async () => {
    const rig = await boundRig();
    const accepted = await rig.writePath.accept(PROFILE, addRows());
    if (accepted.kind !== "accepted") throw new Error("accept failed");

    const enriched = await rig.writePath.enrichGetResponse(getFields("s1", "100"), vendorGetResult("100"));
    expect(enriched).toBeDefined();
    const fields = peekSoapResponseFields(Buffer.from(enriched!).toString("utf8"), "GetModificationsBytesEx");
    expect(soapFieldText(fields, "maxVersion")).toBe("101");
    const payload = unpackEnvelope(Buffer.from(soapFieldText(fields, "data")!, "base64"));
    expect(harvestTaskRows(payload).rows.map((row) => row.uid)).toEqual([TASK]);
  });

  it("merges injected rows into the vendor's own delta and rides its advance unbumped", async () => {
    const rig = await boundRig();
    await rig.writePath.accept(PROFILE, addRows());
    const vendorTask = "{99999999-8888-7777-6666-555555555555}";
    const vendorDoc = buildTaskAddDelta({
      uid: vendorTask, caption: "mobile task",
      createdDate: "2026-07-27T08:00:00", lastModified: "2026-07-27T08:00:00",
    });
    const enriched = await rig.writePath.enrichGetResponse(getFields("s1", "100"), vendorGetResult("150", vendorDoc));
    const fields = peekSoapResponseFields(Buffer.from(enriched!).toString("utf8"), "GetModificationsBytesEx");
    expect(soapFieldText(fields, "maxVersion")).toBe("150");
    const payload = unpackEnvelope(Buffer.from(soapFieldText(fields, "data")!, "base64"));
    expect(harvestTaskRows(payload).rows.map((row) => row.uid).sort()).toEqual([TASK, vendorTask].sort());
  });

  it("forwards verbatim for a UID that is not bound — the binding is the injection gate", async () => {
    const rig = await boundRig();
    await rig.writePath.accept(PROFILE, addRows());
    const foreign = { dataFileUID: "{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}", sessionID: "s1", newerThan: "100" };
    expect(await rig.writePath.enrichGetResponse(foreign, vendorGetResult("100"))).toBeUndefined();
    // and the queue still holds the write
    const partition = await rig.gateway.registry.open(UID);
    expect(await partition.queue.pending()).toHaveLength(1);
  });

  it("does not re-inject while the write rides an in-flight session; a Release frees it", async () => {
    const rig = await boundRig();
    await rig.writePath.accept(PROFILE, addRows());
    expect(await rig.writePath.enrichGetResponse(getFields("s1", "100"), vendorGetResult("100"))).toBeDefined();
    // second Get, first session unresolved: nothing to inject, verbatim
    expect(await rig.writePath.enrichGetResponse(getFields("s2", "101"), vendorGetResult("100"))).toBeUndefined();
    // the session dies without an Apply — Release unpins, the next Get re-delivers
    rig.writePath.observeRelease({ dataFileUID: UID, sessionID: "s1" });
    expect(await rig.writePath.enrichGetResponse(getFields("s3", "101"), vendorGetResult("100"))).toBeDefined();
  });
});

describe("Apply observation", () => {
  async function injectedRig(): Promise<{ rig: Rig; writeId: string; rows: DeltaRow[] }> {
    const rig = await boundRig();
    const rows = addRows();
    const accepted = await rig.writePath.accept(PROFILE, rows);
    if (accepted.kind !== "accepted") throw new Error("accept failed");
    await rig.writePath.enrichGetResponse(getFields("s1", "100"), vendorGetResult("100"));
    return { rig, writeId: accepted.writeId, rows };
  }

  it("matching content in MLO's Apply delivers the write", async () => {
    const { rig, writeId, rows } = await injectedRig();
    await rig.writePath.observeApply(applyRequestFields("s1", reExportOf(rows, { LastModified: "2026-07-27T09:59:59" })), applyResult(true, "151"));
    const lookup = await rig.writePath.status(writeId);
    expect(lookup?.status).toBe("delivered");
    const partition = await rig.gateway.registry.open(UID);
    expect(await partition.queue.pending()).toHaveLength(0);
  });

  it("same UID with differing content is superseded, never delivered", async () => {
    const { rig, writeId, rows } = await injectedRig();
    await rig.writePath.observeApply(
      applyRequestFields("s1", reExportOf(rows, { Caption: "the user's own words" })),
      applyResult(true, "151"),
    );
    const lookup = await rig.writePath.status(writeId);
    expect(lookup?.status).toBe("superseded");
    expect(lookup?.detail).toMatch(/conflict|local-wins|different row/i);
  });

  it("a tombstoned delete delivers; a live row for a deleted UID supersedes", async () => {
    const rig = await boundRig();
    const deleteRows = deltaRowsFromDocument(buildTaskDeleteDelta([TASK]));
    const accepted = await rig.writePath.accept(PROFILE, deleteRows);
    if (accepted.kind !== "accepted") throw new Error("accept failed");
    await rig.writePath.enrichGetResponse(getFields("s1", "100"), vendorGetResult("100"));
    await rig.writePath.observeApply(applyRequestFields("s1", buildTaskDeleteDelta([TASK])), applyResult(true, "151"));
    expect((await rig.writePath.status(accepted.writeId))?.status).toBe("delivered");
  });

  it("a rejected Apply resolves nothing — MLO's own retry owns the moment", async () => {
    const { rig, writeId, rows } = await injectedRig();
    await rig.writePath.observeApply(applyRequestFields("s1", reExportOf(rows)), applyResult(false));
    expect((await rig.writePath.status(writeId))?.status).toBe("accepted");
  });

  it("an Apply touching a merely-queued (never injected) write judges nothing", async () => {
    const rig = await boundRig();
    const rows = addRows();
    const accepted = await rig.writePath.accept(PROFILE, rows);
    if (accepted.kind !== "accepted") throw new Error("accept failed");
    await rig.writePath.observeApply(
      applyRequestFields("s1", reExportOf(rows, { Caption: "user edit before injection" })),
      applyResult(true, "151"),
    );
    expect((await rig.writePath.status(accepted.writeId))?.status).toBe("accepted");
  });
});

describe("TTL expiry", () => {
  it("expires an overdue write into the dead-letter file and never re-injects it", async () => {
    const rig = await boundRig({ ttlMs: 60_000 });
    const accepted = await rig.writePath.accept(PROFILE, addRows(TASK, "doomed write"));
    if (accepted.kind !== "accepted") throw new Error("accept failed");

    rig.clock.now = new Date(rig.clock.now.getTime() + 61_000);
    // the next queue consultation sweeps: nothing injects, the write is resolved
    expect(await rig.writePath.enrichGetResponse(getFields("s1", "100"), vendorGetResult("100"))).toBeUndefined();

    const lookup = await rig.writePath.status(accepted.writeId);
    expect(lookup?.status).toBe("expired");
    expect(lookup?.detail).toMatch(/write-expired/);
    const letters = await rig.gateway.deadLetters.all();
    expect(letters).toHaveLength(1);
    expect(letters[0]!.reason).toMatch(/write-expired/);
    expect(letters[0]!.content).toBe("doomed write");
    const partition = await rig.gateway.registry.open(UID);
    expect(await partition.queue.pending()).toHaveLength(0);
  });

  it("status() alone sweeps expiry — no traffic needed to learn a write expired", async () => {
    const rig = await boundRig({ ttlMs: 60_000 });
    const accepted = await rig.writePath.accept(PROFILE, addRows());
    if (accepted.kind !== "accepted") throw new Error("accept failed");
    rig.clock.now = new Date(rig.clock.now.getTime() + 61_000);
    expect((await rig.writePath.status(accepted.writeId))?.status).toBe("expired");
  });
});

describe("GetFileTS nudge", () => {
  it("answers advanced only while the queue is non-empty, verbatim once drained", async () => {
    const rig = await boundRig();
    // drained queue: verbatim
    expect(await rig.writePath.nudgeFileTs({ dataFileUID: UID }, fileTsResult("147"))).toBeUndefined();

    await rig.writePath.accept(PROFILE, addRows());
    const nudged = await rig.writePath.nudgeFileTs({ dataFileUID: UID }, fileTsResult("147"));
    expect(nudged).toBeDefined();
    const fields = peekSoapResponseFields(Buffer.from(nudged!).toString("utf8"), "GetFileTS");
    expect(soapFieldText(fields, "GetFileTSResult")).toBe("148");
  });

  it("presents the same advanced stamp the Get will present after a bump", async () => {
    const rig = await boundRig();
    await rig.writePath.accept(PROFILE, addRows());
    // a Get bumped to 101 but the session aborted; MLO stored 101
    await rig.writePath.enrichGetResponse(getFields("s1", "100"), vendorGetResult("100"));
    rig.writePath.observeRelease({ dataFileUID: UID, sessionID: "s1" });
    const nudged = await rig.writePath.nudgeFileTs({ dataFileUID: UID }, fileTsResult("100"));
    const fields = peekSoapResponseFields(Buffer.from(nudged!).toString("utf8"), "GetFileTS");
    expect(soapFieldText(fields, "GetFileTSResult")).toBe("102"); // past the stored 101
  });

  it("stays out of foreign polls entirely", async () => {
    const rig = await boundRig();
    await rig.writePath.accept(PROFILE, addRows());
    expect(await rig.writePath.nudgeFileTs({ dataFileUID: "{FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF}" }, fileTsResult("147")))
      .toBeUndefined();
  });
});

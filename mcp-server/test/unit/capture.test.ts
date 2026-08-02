import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { captureTlsConnectSeen, captureVendorSession } from "../../src/cloud/capture.js";
import { packEnvelope } from "../../src/cloud/envelope.js";
import { mergeDeltas } from "../../src/cloud/delta-merge.js";
import { buildTaskAddDelta, buildTaskDeleteDelta } from "../../src/cloud/mlo-schema.js";
import type { ForwardResult } from "../../src/cloud/upstream.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempGateway(): Promise<CloudGateway> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-capture-"));
  dirs.push(root);
  return new CloudGateway({ stateRoot: root });
}

const UID = "{DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD}";
const TASK_A = "{11111111-1111-1111-1111-111111111111}";
const TASK_B = "{22222222-2222-2222-2222-222222222222}";

function taskDocument(uid: string, caption: string) {
  return buildTaskAddDelta({ uid, caption, createdDate: "2026-07-27T10:00:00", lastModified: "2026-07-27T10:00:00" });
}

function getResponse(fields: string): ForwardResult {
  const xml = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body><GetModificationsBytesExResponse xmlns="http://www.mylifeorganized.net/">${fields}</GetModificationsBytesExResponse>` +
    `</soap:Body></soap:Envelope>`;
  return { status: 200, headers: {}, body: Buffer.from(xml, "utf8") };
}

function envelopeBase64(document: ReturnType<typeof taskDocument>): string {
  return Buffer.from(packEnvelope(document)).toString("base64");
}

describe("passive capture tap", () => {
  it("feeds a forwarded Get payload into the bound partition's row store and journals ok", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    const payload = mergeDeltas([taskDocument(TASK_A, "from vendor"), buildTaskDeleteDelta([TASK_B])]);
    await captureVendorSession(gateway, "GetModificationsBytesEx", { dataFileUID: UID }, getResponse(
      `<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>15</maxVersion>` +
      `<data>${envelopeBase64(payload)}</data>`,
    ));
    const lookup = await partition.rows.latest(TASK_A);
    expect(lookup.kind).toBe("row");
    if (lookup.kind === "row") expect(lookup.source).toBe("vendor-get");
    const entries = await partition.journal.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("ok");
  });

  it("captures a forwarded Apply request payload — MLO's own edits are the freshest rows", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    await captureVendorSession(
      gateway,
      "ApplyModificationsBytesEx",
      { dataFileUID: UID, data: envelopeBase64(taskDocument(TASK_A, "edited in MLO")) },
      { status: 200, headers: {}, body: Buffer.from("<irrelevant/>") },
    );
    const lookup = await partition.rows.latest(TASK_A);
    expect(lookup.kind).toBe("row");
    if (lookup.kind === "row") {
      expect(lookup.source).toBe("mlo-apply");
      expect(lookup.cells[lookup.header.indexOf("Caption")]).toBe("edited in MLO");
    }
  });

  it("journals an empty Get as a healthy observation", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    await captureVendorSession(gateway, "GetModificationsBytesEx", { dataFileUID: UID }, getResponse(
      `<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>15</maxVersion>`,
    ));
    expect((await partition.journal.gauge()).state).toBe("ok");
    expect(await partition.rows.size()).toBe(0);
  });

  it("journals failed on an unreadable payload and never throws", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    const corruptZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("garbage")]).toString("base64");
    await captureVendorSession(gateway, "GetModificationsBytesEx", { dataFileUID: UID }, getResponse(
      `<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>15</maxVersion><data>${corruptZip}</data>`,
    ));
    expect((await partition.journal.entries())[0]!.outcome).toBe("failed");
  });

  it("journals skipped for a raw projection payload instead of guessing at it", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    const rawCsv = Buffer.from("[TodoItems]\nUID,Caption\n", "utf8").toString("base64");
    await captureVendorSession(gateway, "GetModificationsBytesEx", { dataFileUID: UID }, getResponse(
      `<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>15</maxVersion><data>${rawCsv}</data>`,
    ));
    expect((await partition.journal.entries())[0]!.outcome).toBe("skipped");
    expect(await partition.rows.size()).toBe(0);
  });

  it("journals skipped when the vendor honestly reports failure", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    await captureVendorSession(gateway, "GetModificationsBytesEx", { dataFileUID: UID }, getResponse(
      `<GetModificationsBytesExResult>false</GetModificationsBytesExResult>`,
    ));
    const entries = await partition.journal.entries();
    expect(entries[0]!.outcome).toBe("skipped");
    expect(entries[0]!.detail).toContain("vendor reported failure");
  });

  it("journals failed, not skipped, when the vendor's 200 response is unparseable", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    await captureVendorSession(gateway, "GetModificationsBytesEx", { dataFileUID: UID }, {
      status: 200,
      headers: {},
      body: Buffer.from("<html>gateway error page, not SOAP</html>", "utf8"),
    });
    const entries = await partition.journal.entries();
    expect(entries[0]!.outcome).toBe("failed");
    expect(entries[0]!.detail).toContain("malformed");
    expect(entries[0]!.detail).not.toContain("vendor reported failure");
  });

  it("journals failed when a parseable response lacks the Result field — not an honest vendor failure", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    await captureVendorSession(gateway, "GetModificationsBytesEx", { dataFileUID: UID }, getResponse(""));
    const entries = await partition.journal.entries();
    expect(entries[0]!.outcome).toBe("failed");
    expect(entries[0]!.detail).toContain("malformed");
    expect(entries[0]!.detail).not.toContain("vendor reported failure");
  });

  it("stays out of the way of a UID this server does not manage — no partition is ever created", async () => {
    const gateway = await tempGateway();
    await captureVendorSession(gateway, "GetModificationsBytesEx", { dataFileUID: UID }, getResponse(
      `<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>15</maxVersion>` +
      `<data>${envelopeBase64(taskDocument(TASK_A, "foreign"))}</data>`,
    ));
    expect(await gateway.registry.resolveExisting(UID)).toBeUndefined();
    expect(await gateway.registry.list()).toEqual([]);
  });

  it("records tls-connect-seen in every managed partition's journal", async () => {
    const gateway = await tempGateway();
    const partition = await gateway.registry.open(UID);
    await captureTlsConnectSeen(gateway, "sync.mylifeorganized.net", 443);
    const gauge = await partition.journal.gauge();
    expect(gauge.state).toBe("degraded");
    expect(gauge.counts["tls-connect-seen"]).toBe(1);
  });
});

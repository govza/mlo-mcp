import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSection } from "../../src/cloud/csv.js";
import { parseCursor } from "../../src/cloud/cursor.js";
import { buildTaskAddDelta } from "../../src/cloud/delta.js";
import { packEnvelope, unpackEnvelope } from "../../src/cloud/envelope.js";
import { handleSoapOperation, soapOperationFromAction } from "../../src/cloud/soap.js";
import { CloudState } from "../../src/cloud/state.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

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

function taskDelta(uid: string, caption: string): Uint8Array {
  return packEnvelope(buildTaskAddDelta({
    uid,
    caption,
    createdDate: "2026-07-19T12:00:00",
    lastModified: "2026-07-19T12:00:00",
  }));
}

describe("MLO SOAP compatibility", () => {
  it("recognizes only the supported vendor SOAP actions", () => {
    expect(soapOperationFromAction('"http://www.mylifeorganized.net/GetModificationsBytesEx"'))
      .toBe("GetModificationsBytesEx");
    expect(soapOperationFromAction("http://www.mylifeorganized.net/ApplyModificationsBytesEx"))
      .toBe("ApplyModificationsBytesEx");
    expect(soapOperationFromAction("http://www.mylifeorganized.net/LoginBytes")).toBeUndefined();
  });

  it("rebases and returns queued MCP deltas through GetModificationsBytesEx", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-soap-")); dirs.push(dir);
    const state = new CloudState(dir);
    const legacy = buildTaskAddDelta({
      uid: "{12345678-1234-1234-1234-123456789ABC}",
      caption: "from local cloud",
      createdDate: "2026-07-19T12:00:00",
      lastModified: "2026-07-19T12:00:00",
    });
    const legacyTasks = findSection(legacy, "TodoItems")!;
    legacyTasks.rows[0]![legacyTasks.header.indexOf("ItemIndex")] = "";
    await state.append("mcp", packEnvelope(legacy));

    const response = await handleSoapOperation(state, "GetModificationsBytesEx", soapRequest("GetModificationsBytesEx", {
      loginBytes: "dGVzdA==",
      passwordBytes: "dGVzdA==",
      sessionID: "test-session",
      dataFileUID: "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}",
      newerThan: "100",
    }));

    expect(responseField(response, "GetModificationsBytesExResult")).toBe("true");
    expect(responseField(response, "maxVersion")).toBe("101");
    const data = responseField(response, "data");
    expect(data).toBeDefined();
    const document = unpackEnvelope(Buffer.from(data!, "base64"));
    const tasks = findSection(document, "TodoItems")!;
    expect(tasks.rows[0]?.[tasks.header.indexOf("Caption")]).toBe("from local cloud");
    expect(tasks.rows[0]?.[tasks.header.indexOf("ItemIndex")]).toBe("100");
    expect(tasks.rows[0]?.[tasks.header.indexOf("Importance")]).toBe("100");
    expect(await state.lastPullCursor("app")).toBe(101n);

    const empty = await handleSoapOperation(state, "GetModificationsBytesEx", soapRequest("GetModificationsBytesEx", {
      newerThan: "101",
    }));
    expect(responseField(empty, "GetModificationsBytesExResult")).toBe("true");
    expect(responseField(empty, "maxVersion")).toBe("101");
    const emptyData = responseField(empty, "data");
    expect(emptyData).toBeDefined();
    expect(findSection(unpackEnvelope(Buffer.from(emptyData!, "base64")), "TodoItems")!.rows).toEqual([]);
  });

  it("accepts app deltas and finalizes the session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-soap-")); dirs.push(dir);
    const state = new CloudState(dir);
    await state.adoptInitialBaseline("app", parseCursor("100"));
    const delta = taskDelta("{ABCDEFAB-1234-1234-1234-ABCDEFABCDEF}", "from MLO");

    const applied = await handleSoapOperation(state, "ApplyModificationsBytesEx", soapRequest("ApplyModificationsBytesEx", {
      lastSyncTimestamp: "100",
      data: Buffer.from(delta).toString("base64"),
    }));
    expect(responseField(applied, "ApplyModificationsBytesExResult")).toBe("true");
    expect(responseField(applied, "newServerTimeStamp")).toBe("101");
    expect(await state.counts()).toEqual({ mcp: 0, app: 1 });

    const finalized = await handleSoapOperation(state, "ReleaseSyncSessionBytes", soapRequest("ReleaseSyncSessionBytes", {
      sessionID: "test-session",
    }));
    expect(responseField(finalized, "ReleaseSyncSessionBytesResult")).toBe("true");
    const persisted = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as Record<string, unknown>;
    expect(persisted.lastFinalized).toEqual(expect.any(String));
  });

  it("returns a protocol failure without appending malformed upload data", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-soap-")); dirs.push(dir);
    const state = new CloudState(dir);
    const response = await handleSoapOperation(state, "ApplyModificationsBytesEx", soapRequest("ApplyModificationsBytesEx", {
      lastSyncTimestamp: "0",
      data: Buffer.from("not a zip").toString("base64"),
    }));
    expect(responseField(response, "ApplyModificationsBytesExResult")).toBe("false");
    expect(responseField(response, "newServerTimeStamp")).toBe("0");
    expect(await state.counts()).toEqual({ mcp: 0, app: 0 });
  });
});

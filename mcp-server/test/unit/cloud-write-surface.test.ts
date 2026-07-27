import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { buildTaskAddDelta, deltaRowsFromDocument } from "../../src/cloud/mlo-schema.js";
import { unpackEnvelope } from "../../src/cloud/envelope.js";
import { peekSoapResponseFields, soapFieldText } from "../../src/cloud/soap.js";
import { harvestTaskRows } from "../../src/cloud/row-store.js";
import { PROBLEM_CONTENT_TYPE } from "../../src/cloud/problem.js";
import type { DeltaRow } from "../../src/repo/mlo-repository.js";

/**
 * The resident HTTP surface end to end (ticket 06): the write routes, the
 * closed non-proxy surface, and injection/nudge riding a real proxied SOAP
 * exchange against a stub vendor.
 */

const UID = "{ABCDABCD-ABCD-ABCD-ABCD-ABCDABCDABCD}";
const PROFILE = "C:/profiles/write-surface.ml";

const handles: CloudServerHandle[] = [];
const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-write-surface-"));
  dirs.push(dir);
  return dir;
}

async function boundServer(): Promise<CloudServerHandle> {
  const gateway = new CloudGateway({ stateRoot: await tempRoot() });
  await gateway.bindings.create(PROFILE, "upstream");
  await gateway.bindings.bindUid(PROFILE, UID);
  const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
  handles.push(handle);
  return handle;
}

function sampleRows(caption = "surface add"): DeltaRow[] {
  return deltaRowsFromDocument(buildTaskAddDelta({
    uid: "{12121212-3434-5656-7878-909090909090}",
    caption,
    createdDate: "2026-07-27T10:00:00",
    lastModified: "2026-07-27T10:00:00",
  }));
}

async function postWrite(handle: CloudServerHandle, body: unknown): Promise<Response> {
  return fetch(`http://${handle.host}:${handle.port}/v1/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A stub vendor whose SOAP answers are scripted per operation. */
async function stubVendor(answers: Record<string, string>): Promise<number> {
  const server = http.createServer(async (request, response) => {
    const action = String(request.headers.soapaction ?? "").replace(/"/g, "");
    const operation = action.slice(action.lastIndexOf("/") + 1);
    for await (const _chunk of request) { /* drain */ }
    const fields = answers[operation] ?? "";
    const xml = `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<${operation}Response xmlns="http://www.mylifeorganized.net/">${fields}</${operation}Response>` +
      `</soap:Body></soap:Envelope>`;
    response.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
    response.end(xml);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

function proxiedSoap(
  handle: CloudServerHandle,
  vendorPort: number,
  operation: string,
  fields: Record<string, string>,
): Promise<string> {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation} xmlns="http://www.mylifeorganized.net/">` +
    Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("") +
    `</${operation}></soap:Body></soap:Envelope>`;
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: handle.host,
      port: handle.port,
      method: "POST",
      path: `http://127.0.0.1:${vendorPort}/mlo/MLOInetSync.asmx`,
      headers: { "content-type": "text/xml", soapaction: `"http://www.mylifeorganized.net/${operation}"` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
    request.end(xml);
  });
}

describe("write routes", () => {
  it("POST /v1/write accepts and GET /v1/write/:id answers the receipt", async () => {
    const handle = await boundServer();
    const accepted = await postWrite(handle, { profile: PROFILE, rows: sampleRows() });
    expect(accepted.status).toBe(200);
    const receipt = await accepted.json() as { writeId: string; uid: string; status: string; expiresAt: string };
    expect(receipt.status).toBe("accepted");
    expect(receipt.writeId).toBeTruthy();
    expect(Date.parse(receipt.expiresAt)).toBeGreaterThan(Date.now());

    const status = await fetch(`http://${handle.host}:${handle.port}/v1/write/${receipt.writeId}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ writeId: receipt.writeId, status: "accepted" });
  });

  it("refusals are problem+json with typed kinds", async () => {
    const handle = await boundServer();
    const invalid = await postWrite(handle, { profile: PROFILE, rows: [] });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
    expect(await invalid.json()).toMatchObject({ type: "urn:mlo-mcp:invalid-request" });

    const unbound = await postWrite(handle, { profile: "C:/profiles/unbound.ml", rows: sampleRows() });
    expect(unbound.status).toBe(409);
    expect(await unbound.json()).toMatchObject({ type: "urn:mlo-mcp:partition-not-ready", retryable: "after-user-action" });

    const unknown = await fetch(`http://${handle.host}:${handle.port}/v1/write/w-never`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ type: "urn:mlo-mcp:unknown-write" });
  });

  it("the non-proxy surface is closed: exactly four routes, deleted routes answer 404", async () => {
    const handle = await boundServer();
    const url = (route: string) => `http://${handle.host}:${handle.port}${route}`;
    // the four that exist
    expect((await fetch(url("/v1/status"))).status).toBe(200);
    expect((await postWrite(handle, { profile: PROFILE, rows: sampleRows() })).status).toBe(200);
    const receipt = await (await postWrite(handle, { profile: PROFILE, rows: sampleRows() })).json() as { writeId: string };
    expect((await fetch(url(`/v1/write/${receipt.writeId}`))).status).toBe(200);
    // shutdown exists too, but calling it would stop the server under test
    // everything deleted answers 404
    for (const gone of ["/v1/pull", "/v1/push", "/v1/finalize", "/v1/upstream/refresh", "/v1/upstream/commit", "/v1/upstream/history"]) {
      const response = await fetch(url(gone), { method: "POST", body: "{}" });
      expect(response.status, gone).toBe(404);
    }
  });
});

describe("injection through the proxied exchange", () => {
  it("a forwarded Get for the bound UID carries the queued write with a bumped stamp", async () => {
    const handle = await boundServer();
    const vendorPort = await stubVendor({
      GetModificationsBytesEx:
        "<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>100</maxVersion>",
    });
    const receipt = await (await postWrite(handle, { profile: PROFILE, rows: sampleRows("injected e2e") })).json() as { uid: string };

    const body = await proxiedSoap(handle, vendorPort, "GetModificationsBytesEx",
      { dataFileUID: UID, sessionID: "s1", newerThan: "100" });
    const fields = peekSoapResponseFields(body, "GetModificationsBytesEx");
    expect(soapFieldText(fields, "maxVersion")).toBe("101");
    const payload = unpackEnvelope(Buffer.from(soapFieldText(fields, "data")!, "base64"));
    expect(harvestTaskRows(payload).rows.map((row) => row.uid)).toEqual([receipt.uid]);
  });

  it("a Get for any other UID forwards the vendor's answer verbatim", async () => {
    const handle = await boundServer();
    const vendorPort = await stubVendor({
      GetModificationsBytesEx:
        "<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>100</maxVersion>",
    });
    await postWrite(handle, { profile: PROFILE, rows: sampleRows() });
    const body = await proxiedSoap(handle, vendorPort, "GetModificationsBytesEx",
      { dataFileUID: "{FEFEFEFE-FEFE-FEFE-FEFE-FEFEFEFEFEFE}", sessionID: "s1", newerThan: "100" });
    const fields = peekSoapResponseFields(body, "GetModificationsBytesEx");
    expect(soapFieldText(fields, "maxVersion")).toBe("100");
    expect(soapFieldText(fields, "data")).toBeUndefined();
  });

  it("MLO's own Apply with matching content resolves the write to delivered", async () => {
    const handle = await boundServer();
    const vendorPort = await stubVendor({
      GetModificationsBytesEx:
        "<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>100</maxVersion>",
      ApplyModificationsBytesEx:
        "<ApplyModificationsBytesExResult>true</ApplyModificationsBytesExResult><newServerTimeStamp>101</newServerTimeStamp>",
    });
    const rows = sampleRows("apply e2e");
    const receipt = await (await postWrite(handle, { profile: PROFILE, rows })).json() as { writeId: string };

    const get = await proxiedSoap(handle, vendorPort, "GetModificationsBytesEx",
      { dataFileUID: UID, sessionID: "s1", newerThan: "100" });
    // MLO re-exports exactly what it received
    const echoed = soapFieldText(peekSoapResponseFields(get, "GetModificationsBytesEx"), "data")!;
    await proxiedSoap(handle, vendorPort, "ApplyModificationsBytesEx",
      { dataFileUID: UID, sessionID: "s1", lastSyncTimestamp: "100", data: echoed });

    // observation is fire-and-forget behind the response; give it a beat
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await fetch(`http://${handle.host}:${handle.port}/v1/write/${receipt.writeId}`);
    expect(await status.json()).toMatchObject({ status: "delivered" });
  });

  it("GetFileTS answers advanced while the queue is non-empty, verbatim once drained", async () => {
    const handle = await boundServer();
    const vendorPort = await stubVendor({
      GetFileTS: "<GetFileTSResult>147</GetFileTSResult>",
    });
    // drained: verbatim
    const before = await proxiedSoap(handle, vendorPort, "GetFileTS", { dataFileUID: UID });
    expect(soapFieldText(peekSoapResponseFields(before, "GetFileTS"), "GetFileTSResult")).toBe("147");

    await postWrite(handle, { profile: PROFILE, rows: sampleRows() });
    const nudged = await proxiedSoap(handle, vendorPort, "GetFileTS", { dataFileUID: UID });
    expect(soapFieldText(peekSoapResponseFields(nudged, "GetFileTS"), "GetFileTSResult")).toBe("148");
  });
});

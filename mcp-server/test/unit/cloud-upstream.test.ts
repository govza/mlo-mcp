import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { buildTaskAddDelta, mergeDeltas } from "../../src/cloud/delta.js";
import { packEnvelope } from "../../src/cloud/envelope.js";
import { findSection, type SectionedCsv } from "../../src/cloud/csv.js";
import { knownCloudProjection, rowValue } from "../../src/cloud/log-projection.js";
import { requireWritableCloudState, resolveReadCloudState, type ToolContext } from "../../src/tools/shared.js";
import type { MloConfig } from "../../src/types.js";

const dirs: string[] = [];
const handles: CloudServerHandle[] = [];
const vendors: http.Server[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(vendors.splice(0).map((vendor) => new Promise((resolve) => vendor.close(resolve))));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const PROFILE = "C:\\Profiles\\Personal.ml";
const UID = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const TASK_UID = "{11111111-1111-1111-1111-111111111111}";

function fullSnapshot(caption = "Existing task"): SectionedCsv {
  const document = mergeDeltas([
    buildTaskAddDelta({
      uid: TASK_UID,
      caption,
      createdDate: "2026-07-01T08:00:00",
      lastModified: "2026-07-01T08:00:00",
    }),
  ]);
  document.sections.push({ name: "Config", header: ["Name", "Value"], rows: [["SORT_TYPE", "1"]] });
  return document;
}

function soapEnvelope(operation: string, fields: Record<string, string>): string {
  const body = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation} xmlns="http://www.mylifeorganized.net/">${body}</${operation}>` +
    `</soap:Body></soap:Envelope>`;
}

function vendorResponse(operation: string, fields: Record<string, string>): string {
  const body = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation}Response xmlns="http://www.mylifeorganized.net/">${body}</${operation}Response>` +
    `</soap:Body></soap:Envelope>`;
}

interface VendorCall { operation: string; body: string }

/** A scripted fake vendor: answers per-operation and records what it saw. */
async function startVendor(script: (operation: string, body: string) => { status?: number; body: string }): Promise<{ port: number; calls: VendorCall[] }> {
  const calls: VendorCall[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const action = (request.headers.soapaction ?? "").toString();
      const operation = action.replace(/"/g, "").split("/").pop() ?? "";
      calls.push({ operation, body });
      const answer = script(operation, body);
      response.writeHead(answer.status ?? 200, { "content-type": "text/xml; charset=utf-8", "x-vendor": "fake" });
      response.end(answer.body);
    });
  });
  vendors.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, calls };
}

async function startProxy(gateway: CloudGateway): Promise<CloudServerHandle> {
  const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
  handles.push(handle);
  return handle;
}

/** Absolute-form proxied POST, the shape MLO's proxy setting produces. */
function proxied(handle: CloudServerHandle, vendorPort: number, operation: string, body: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: handle.host,
      port: handle.port,
      method: "POST",
      path: `http://127.0.0.1:${vendorPort}/mlo/MLOInetSync.asmx`,
      headers: {
        "content-type": "text/xml; charset=utf-8",
        soapaction: `"http://www.mylifeorganized.net/${operation}"`,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode!,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function upstreamGateway(): Promise<CloudGateway> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-up-"));
  dirs.push(root);
  const gateway = new CloudGateway({ stateRoot: root, defaultMode: "upstream" });
  await gateway.ensureRoot();
  return gateway;
}

function contextFor(gateway: CloudGateway): ToolContext {
  return {
    config: { dataFile: PROFILE } as MloConfig,
    store: undefined as never,
    cloudState: gateway.defaultState(),
    cloud: gateway,
  };
}

describe("upstream transparent proxy", () => {
  it("forwards all three operations verbatim and returns the vendor response unchanged", async () => {
    const gateway = await upstreamGateway();
    await gateway.bindings!.create(PROFILE, "upstream");
    await gateway.bindings!.bindUid(PROFILE, UID);
    const vendor = await startVendor((operation) => ({
      body: operation === "GetModificationsBytesEx"
        ? vendorResponse(operation, { GetModificationsBytesExResult: "true", maxVersion: "15515" })
        : operation === "ApplyModificationsBytesEx"
          ? vendorResponse(operation, { ApplyModificationsBytesExResult: "true", newServerTimeStamp: "15516" })
          : vendorResponse(operation, { ReleaseSyncSessionBytesResult: "true" }),
    }));
    const proxy = await startProxy(gateway);

    const get = await proxied(proxy, vendor.port, "GetModificationsBytesEx",
      soapEnvelope("GetModificationsBytesEx", { sessionID: "s1", dataFileUID: UID, newerThan: "15514" }));
    expect(get.status).toBe(200);
    expect(get.headers["x-vendor"]).toBe("fake"); // vendor headers pass through
    expect(get.body).toContain("<maxVersion>15515</maxVersion>");

    const apply = await proxied(proxy, vendor.port, "ApplyModificationsBytesEx",
      soapEnvelope("ApplyModificationsBytesEx", { sessionID: "s1", dataFileUID: UID, lastSyncTimestamp: "24838", data: "" }));
    expect(apply.body).toContain("<newServerTimeStamp>15516</newServerTimeStamp>");

    const release = await proxied(proxy, vendor.port, "ReleaseSyncSessionBytes",
      soapEnvelope("ReleaseSyncSessionBytes", { sessionID: "s1", dataFileUID: UID }));
    expect(release.body).toContain("<ReleaseSyncSessionBytesResult>true</ReleaseSyncSessionBytesResult>");

    // The vendor saw the requests byte-for-byte.
    expect(vendor.calls.map((call) => call.operation)).toEqual([
      "GetModificationsBytesEx", "ApplyModificationsBytesEx", "ReleaseSyncSessionBytes",
    ]);
    expect(vendor.calls[0]!.body).toContain("<newerThan>15514</newerThan>");
    expect(vendor.calls[1]!.body).toContain("<lastSyncTimestamp>24838</lastSyncTimestamp>");
    // Nothing was locally cursor-stamped: the local log for this partition stays empty.
    const partition = await gateway.registry!.open(UID);
    expect(await partition.state.highWater()).toBe(0n);
  });

  it("captures an armed re-sync flow into the mirror and reaches ready without touching the vendor exchange", async () => {
    const gateway = await upstreamGateway();
    await gateway.bindings!.create(PROFILE, "upstream");
    await gateway.bootstrap!.arm(PROFILE, "upstream");
    const snapshotB64 = Buffer.from(packEnvelope(fullSnapshot())).toString("base64");
    const vendor = await startVendor((operation) => ({
      body: operation === "GetModificationsBytesEx"
        ? vendorResponse(operation, { GetModificationsBytesExResult: "true", maxVersion: "100", data: "" })
        : operation === "ApplyModificationsBytesEx"
          ? vendorResponse(operation, { ApplyModificationsBytesExResult: "true", newServerTimeStamp: "101" })
          : vendorResponse(operation, { ReleaseSyncSessionBytesResult: "true" }),
    }));
    const proxy = await startProxy(gateway);

    await proxied(proxy, vendor.port, "GetModificationsBytesEx",
      soapEnvelope("GetModificationsBytesEx", { sessionID: "s1", dataFileUID: UID, newerThan: "100" }));
    const apply = await proxied(proxy, vendor.port, "ApplyModificationsBytesEx",
      soapEnvelope("ApplyModificationsBytesEx", { sessionID: "s1", dataFileUID: UID, lastSyncTimestamp: "0", data: snapshotB64 }));
    expect(apply.body).toContain("<newServerTimeStamp>101</newServerTimeStamp>");
    await proxied(proxy, vendor.port, "ReleaseSyncSessionBytes",
      soapEnvelope("ReleaseSyncSessionBytes", { sessionID: "s1", dataFileUID: UID }));

    const partition = await gateway.registry!.open(UID);
    expect(await partition.lifecycle()).toBe("ready");
    expect((await gateway.bindings!.forProfile(PROFILE))?.dataFileUID).toBe(UID);
    expect(await gateway.bootstrap!.current()).toBeUndefined();
    // The mirror holds the upload at the VENDOR-assigned version.
    expect(await partition.mirrorState.highWater()).toBe(101n);
    // Reads resolve through the mirror; writes stay refused in upstream mode.
    const ctx = contextFor(gateway);
    const readState = await resolveReadCloudState(ctx);
    const projection = await knownCloudProjection(readState);
    expect(rowValue(projection.rows.get(TASK_UID)!, "Caption")).toBe("Existing task");
    await expect(requireWritableCloudState(ctx)).rejects.toThrow("write-through is not enabled");
  });

  it("returns the vendor response unchanged even when mirror capture fails", async () => {
    const gateway = await upstreamGateway();
    await gateway.bindings!.create(PROFILE, "upstream");
    await gateway.bindings!.bindUid(PROFILE, UID);
    const vendor = await startVendor((operation) => ({
      body: vendorResponse(operation, {
        [`${operation}Result`]: "true",
        newServerTimeStamp: "200",
      }),
    }));
    const proxy = await startProxy(gateway);
    // "not-a-zip" is accepted by the fake vendor but cannot be captured.
    const apply = await proxied(proxy, vendor.port, "ApplyModificationsBytesEx",
      soapEnvelope("ApplyModificationsBytesEx", {
        sessionID: "s1", dataFileUID: UID, lastSyncTimestamp: "0",
        data: Buffer.from("not a zip").toString("base64"),
      }));
    expect(apply.status).toBe(200);
    expect(apply.body).toContain("<newServerTimeStamp>200</newServerTimeStamp>");
    expect(await gateway.mirrorHealthy()).toBe(false);
    const partition = await gateway.registry!.open(UID);
    expect(await partition.mirrorState.highWater()).toBe(0n);
  });

  it("pins the authority per session so a mid-session binding change cannot switch it", async () => {
    const gateway = await upstreamGateway();
    await gateway.bindings!.create(PROFILE, "upstream");
    await gateway.bindings!.bindUid(PROFILE, UID);
    const vendor = await startVendor((operation) => ({
      body: vendorResponse(operation, { [`${operation}Result`]: "true", maxVersion: "1" }),
    }));
    const proxy = await startProxy(gateway);
    await proxied(proxy, vendor.port, "GetModificationsBytesEx",
      soapEnvelope("GetModificationsBytesEx", { sessionID: "pinned", dataFileUID: UID, newerThan: "0" }));
    expect(vendor.calls).toHaveLength(1);

    // Simulate an operator rebinding the profile to local mid-session.
    await gateway.bindings!.unbindUid(PROFILE);
    // (a fresh local-mode binding for the same UID would normally be a new
    // profile epoch; here we just verify the pin keeps routing upstream)
    const followUp = await proxied(proxy, vendor.port, "ReleaseSyncSessionBytes",
      soapEnvelope("ReleaseSyncSessionBytes", { sessionID: "pinned", dataFileUID: UID }));
    expect(followUp.status).toBe(200);
    expect(vendor.calls).toHaveLength(2); // still forwarded to the vendor
  });

  it("flags the mirror as blind when the vendor sync host is reached via CONNECT", async () => {
    const gateway = await upstreamGateway();
    const proxy = await startProxy(gateway);
    expect(await gateway.mirrorBlind()).toBe(false);
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(proxy.port, proxy.host, () => {
        socket.write("CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n");
      });
      socket.on("data", () => { socket.destroy(); resolve(); });
      socket.on("error", reject);
    });
    // Poll briefly — the flag write is fire-and-forget.
    for (let attempt = 0; attempt < 50 && !(await gateway.mirrorBlind()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await gateway.mirrorBlind()).toBe(true);
  });

  it("keeps an upstream mirror and a local partition with identical content fully separate", async () => {
    const gateway = await upstreamGateway();
    // Profile A: upstream-bound mirror.
    await gateway.bindings!.create(PROFILE, "upstream");
    await gateway.bindings!.bindUid(PROFILE, UID);
    const upstream = await gateway.registry!.open(UID);
    await upstream.mirrorState.appendAtCursor("app", packEnvelope(fullSnapshot("mirror copy")), 50n as never);
    // Profile B: local-mode partition holding the IDENTICAL task UID/caption.
    const LOCAL_UID = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
    await gateway.bindings!.create("C:\\local.ml", "local");
    await gateway.bindings!.bindUid("C:\\local.ml", LOCAL_UID);
    const local = await gateway.registry!.open(LOCAL_UID);
    await local.state.append("mcp", packEnvelope(fullSnapshot("local copy")));

    const mirrorProjection = await knownCloudProjection(upstream.mirrorState);
    const localProjection = await knownCloudProjection(local.state);
    expect(rowValue(mirrorProjection.rows.get(TASK_UID)!, "Caption")).toBe("mirror copy");
    expect(rowValue(localProjection.rows.get(TASK_UID)!, "Caption")).toBe("local copy");
    // Their cursor namespaces are independent too.
    expect(await upstream.mirrorState.highWater()).toBe(50n);
    expect(await local.state.highWater()).toBe(1n);
  });
});

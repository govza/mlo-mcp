import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { SERVER_INFO } from "../../src/version.js";

const handles: CloudServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function soapRequest(operation: string, fields: Record<string, string>): string {
  const xml = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation} xmlns="http://www.mylifeorganized.net/">${xml}</${operation}>` +
    `</soap:Body></soap:Envelope>`;
}

function postSoap(handle: CloudServerHandle, operation: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: handle.host,
      port: handle.port,
      method: "POST",
      path: "http://127.0.0.1:65530/mlo/MLOInetSync.asmx",
      headers: { "content-type": "text/xml", soapaction: `"http://www.mylifeorganized.net/${operation}"` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("cloud HTTP server", () => {
  it("refuses non-loopback binding because the proxy endpoint is unauthenticated", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-bind-")); dirs.push(dir);
    await expect(startCloudServer({ host: "0.0.0.0", port: 0, stateRoot: dir }))
      .rejects.toThrow("must bind to a loopback host");
  });

  it("rejects an unroutable sync operation with a protocol failure, never a transport fault", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-soap-reject-")); dirs.push(dir);
    const gateway = new CloudGateway({ stateRoot: dir });
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
    handles.push(handle);

    const missingUid = await postSoap(handle, "GetModificationsBytesEx",
      soapRequest("GetModificationsBytesEx", { newerThan: "0" }));
    expect(missingUid.status).toBe(200);
    expect(missingUid.body).toContain("<GetModificationsBytesExResult>false</GetModificationsBytesExResult>");
    expect(missingUid.body).toContain("dataFileUID is required");
  });

  it("rejects a dataFileUID still bound in the removed local mode", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-soap-local-")); dirs.push(dir);
    const gateway = new CloudGateway({ stateRoot: dir });
    const UID = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
    await gateway.bindings.create("C:\\demo.ml", "local");
    await gateway.bindings.bindUid("C:\\demo.ml", UID);
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
    handles.push(handle);

    const result = await postSoap(handle, "GetModificationsBytesEx", soapRequest("GetModificationsBytesEx", {
      loginBytes: "c2VjcmV0",
      dataFileUID: UID,
      newerThan: "50",
    }));
    expect(result.status).toBe(200);
    expect(result.body).toContain("<GetModificationsBytesExResult>false</GetModificationsBytesExResult>");
    expect(result.body).toContain("removed local mode");
    expect(result.body).not.toContain("c2VjcmV0");
  });

  it("records a sighting and forwards an unknown dataFileUID to the vendor", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-soap-forward-")); dirs.push(dir);
    // A real local "vendor" so the forward has somewhere to land.
    const vendor = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/xml" });
      response.end("<vendor-answer/>");
    });
    await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve));
    const vendorAddress = vendor.address();
    if (!vendorAddress || typeof vendorAddress === "string") throw new Error("missing vendor address");
    const gateway = new CloudGateway({ stateRoot: dir });
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
    handles.push(handle);
    const UID = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({
        host: handle.host,
        port: handle.port,
        method: "POST",
        path: `http://127.0.0.1:${vendorAddress.port}/mlo/MLOInetSync.asmx`,
        headers: { "content-type": "text/xml", soapaction: '"http://www.mylifeorganized.net/GetModificationsBytesEx"' },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end(soapRequest("GetModificationsBytesEx", { dataFileUID: UID, newerThan: "0" }));
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe("<vendor-answer/>"); // verbatim
    expect((await gateway.unboundSightings()).map((s) => s.dataFileUID)).toEqual([UID]);
    await new Promise<void>((resolve, reject) => vendor.close((error) => error ? reject(error) : resolve()));
  });

  it("passes unrelated HTTP requests and CONNECT tunnels through", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-proxy-")); dirs.push(dir);
    const upstream = http.createServer((request, response) => {
      response.writeHead(201, { "x-upstream": "yes" });
      response.end(`${request.method} ${request.url}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("missing upstream address");
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateRoot: dir }); handles.push(handle);

    const proxied = await new Promise<{ status: number; header?: string; body: string }>((resolve, reject) => {
      const request = http.request({
        host: handle.host, port: handle.port, method: "GET",
        path: `http://127.0.0.1:${upstreamAddress.port}/mlo/MLOInetSync.asmx?WSDL`,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode!, header: response.headers["x-upstream"] as string, body: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject); request.end();
    });
    expect(proxied).toEqual({ status: 201, header: "yes", body: "GET /mlo/MLOInetSync.asmx?WSDL" });

    const tunneled = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(handle.port, handle.host, () => {
        socket.write(`CONNECT 127.0.0.1:${upstreamAddress.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamAddress.port}\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("200 Connection Established") && !data.includes("x-upstream")) {
          socket.write("GET /login HTTP/1.1\r\nHost: upstream\r\nConnection: close\r\n\r\n");
        }
        if (data.includes("GET /login")) resolve(data);
      });
      socket.on("error", reject);
    });
    expect(tunneled).toContain("200 Connection Established");
    expect(tunneled).toContain("GET /login");
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });

  it("serves the attach probe: build version, contact inventory, state root, partitions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-status-")); dirs.push(dir);
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateRoot: dir }); handles.push(handle);

    const status = await fetch(`http://${handle.host}:${handle.port}/v1/status`);
    expect(await status.json()).toMatchObject({
      stateRoot: dir, partitions: [],
      version: SERVER_INFO.version, contactUids: [],
    });

    const gone = await fetch(`http://${handle.host}:${handle.port}/v1/pull`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "mlo-app", cursor: "0" }),
    });
    expect(gone.status).toBe(404); // the second sync protocol is deleted
  });
});

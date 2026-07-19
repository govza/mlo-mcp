import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startCloudServer, startOrAttachCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { buildTaskAddDelta } from "../../src/cloud/delta.js";
import { packEnvelope, unpackEnvelope } from "../../src/cloud/envelope.js";

const handles: CloudServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function post(handle: CloudServerHandle, route: string, body: unknown) {
  const response = await fetch(`http://${handle.host}:${handle.port}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("cloud HTTP server", () => {
  it("refuses non-loopback binding because the local SOAP adapter bypasses vendor authentication", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-bind-")); dirs.push(dir);
    await expect(startCloudServer({ host: "0.0.0.0", port: 0, stateDir: dir }))
      .rejects.toThrow("must bind to a loopback host");
  });

  it("attaches instead of failing when the port is held by another mlo-mcp endpoint", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-attach-")); dirs.push(dir);
    const first = await startCloudServer({ host: "127.0.0.1", port: 0, stateDir: dir }); handles.push(first);
    const second = await startOrAttachCloudServer({ host: "127.0.0.1", port: first.port, stateDir: dir });
    expect(second).toBeUndefined();
  });

  it("still fails when the port is held by something that is not a cloud endpoint", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-attach-other-")); dirs.push(dir);
    const other = http.createServer((_request, response) => { response.writeHead(200); response.end("not mlo"); });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const address = other.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    try {
      await expect(startOrAttachCloudServer({ host: "127.0.0.1", port: address.port, stateDir: dir }))
        .rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve, reject) => other.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("intercepts supported vendor SOAP operations instead of forwarding credentials", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-soap-proxy-")); dirs.push(dir);
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateDir: dir, observeHost: "127.0.0.1" });
    handles.push(handle);
    const delta = packEnvelope(buildTaskAddDelta({ uid: "{12345678-1234-1234-1234-123456789ABC}", caption: "queued", createdDate: "a", lastModified: "a" }));
    await handle.state.append("mcp", delta);
    const requestBody = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<GetModificationsBytesEx xmlns="http://www.mylifeorganized.net/"><loginBytes>c2VjcmV0</loginBytes><newerThan>50</newerThan></GetModificationsBytesEx>` +
      `</soap:Body></soap:Envelope>`;

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({
        host: handle.host,
        port: handle.port,
        method: "POST",
        path: "http://127.0.0.1:65530/mlo/MLOInetSync.asmx",
        headers: { "content-type": "text/xml", soapaction: '"http://www.mylifeorganized.net/GetModificationsBytesEx"' },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end(requestBody);
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain("<GetModificationsBytesExResult>true</GetModificationsBytesExResult>");
    expect(result.body).toContain("<maxVersion>51</maxVersion>");
    expect(result.body).not.toContain("c2VjcmV0");
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
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateDir: dir }); handles.push(handle);

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

  it("implements pull, push validation, filtering, and cursor rules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-server-")); dirs.push(dir);
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateDir: dir }); handles.push(handle);
    expect(await post(handle, "/v1/pull", { client: "mlo-app", cursor: "0" })).toEqual({ status: 200, body: { cursor: "0" } });

    const delta = packEnvelope(buildTaskAddDelta({ uid: "{12345678-1234-1234-1234-123456789ABC}", caption: "queued", createdDate: "a", lastModified: "a" }));
    await handle.state.append("mcp", delta);
    const pulled = await post(handle, "/v1/pull", { client: "mlo-app", cursor: "0" });
    expect(pulled.status).toBe(200);
    expect(pulled.body.cursor).toBe("1");
    expect(unpackEnvelope(Buffer.from(pulled.body.envelope as string, "base64"))).toBeTruthy();

    const pushed = await post(handle, "/v1/push", { client: "mlo-app", baseline: "1", envelope: Buffer.from(delta).toString("base64") });
    expect(pushed).toEqual({ status: 200, body: { cursor: "2" } });
    expect(await post(handle, "/v1/pull", { client: "mlo-app", cursor: "1" })).toEqual({ status: 200, body: { cursor: "2" } });
    expect((await post(handle, "/v1/push", { client: "mlo-app", baseline: "3", envelope: Buffer.from(delta).toString("base64") })).status).toBe(409);

    const before = await handle.state.highWater();
    expect((await post(handle, "/v1/push", { client: "mlo-app", baseline: "2", envelope: Buffer.from("garbage").toString("base64") })).status).toBe(400);
    expect(await handle.state.highWater()).toBe(before);

    // The app pulled through cursor 2, so nothing is pending for it.
    const status = await fetch(`http://${handle.host}:${handle.port}/v1/status`);
    expect(await status.json()).toEqual({ cursor: "2", entries: { mcp: 1, app: 1 }, pendingForApp: 0 });
  });
});

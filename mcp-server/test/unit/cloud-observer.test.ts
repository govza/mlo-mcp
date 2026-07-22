import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { maskSensitiveField, operationShape, SUMMARY_FILE } from "../../src/cloud/sync-observer.js";

const SOAP_REQUEST = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetChanges xmlns="http://mlo.example/">
      <fromVersion>100</fromVersion>
      <profile>p9</profile>
      <fromVersion>100</fromVersion>
    </GetChanges>
  </soap:Body>
</soap:Envelope>`;

const SOAP_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetChangesResponse xmlns="http://mlo.example/">
      <GetChangesResult>zipbytes</GetChangesResult>
      <serverVersion>104</serverVersion>
      <userToken>secret</userToken>
    </GetChangesResponse>
  </soap:Body>
</soap:Envelope>`;

describe("operationShape", () => {
  it("extracts the operation and deduplicated field names from the SOAP body", () => {
    expect(operationShape(SOAP_REQUEST)).toEqual({ operation: "GetChanges", fields: ["fromVersion", "profile"] });
  });

  it("returns <unknown> when there is no body or operation", () => {
    expect(operationShape("<html>login</html>")).toEqual({ operation: "<unknown>", fields: [] });
    expect(operationShape("<s:Envelope><s:Body></s:Body></s:Envelope>")).toEqual({ operation: "<unknown>", fields: [] });
  });
});

describe("maskSensitiveField", () => {
  it("masks credential-shaped names and passes others through", () => {
    expect(maskSensitiveField("userToken")).toBe("<sensitive-field>");
    expect(maskSensitiveField("Password")).toBe("<sensitive-field>");
    expect(maskSensitiveField("serverVersion")).toBe("serverVersion");
  });
});

describe("proxy sync observation", () => {
  const handles: CloudServerHandle[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.stop()));
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function readSummaries(dir: string, count: number): Promise<Record<string, unknown>[]> {
    // appends are fire-and-forget; poll briefly for the expected line count
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const lines = (await fs.readFile(path.join(dir, SUMMARY_FILE), "utf8")).trim().split("\n");
        if (lines.length >= count) return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* not written yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`summary file never reached ${count} line(s)`);
  }

  it("summarizes observed-host SOAP exchanges and records CONNECTs, names only", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-observe-")); dirs.push(dir);
    const upstream = http.createServer((request, response) => {
      if (request.url === "/mlo/MLOInetSync.asmx?WSDL") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>wsdl here</html>");
      } else {
        response.writeHead(200, { "content-type": "text/xml; charset=utf-8", "content-encoding": "gzip" });
        response.end(zlib.gzipSync(SOAP_RESPONSE));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateRoot: dir, observeHost: "127.0.0.1" });
    handles.push(handle);

    const send = (targetPath: string, body?: string) =>
      new Promise<number>((resolve, reject) => {
        const request = http.request({
          host: handle.host, port: handle.port, method: body === undefined ? "GET" : "POST",
          path: `http://127.0.0.1:${upstreamPort}${targetPath}`,
          headers: body === undefined ? {} : { "content-type": "text/xml", soapaction: '"http://mlo.example/GetChanges"' },
        }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        });
        request.on("error", reject);
        request.end(body);
      });

    expect(await send("/mlo/MLOInetSync.asmx?WSDL")).toBe(200);
    expect(await send("/mlo/MLOInetSync.asmx", SOAP_REQUEST)).toBe(200);
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(handle.port, handle.host, () => {
        socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
      });
      socket.on("data", () => { socket.destroy(); resolve(); });
      socket.on("error", reject);
    });

    const summaries = await readSummaries(dir, 3);
    expect(summaries.map((entry) => entry.kind)).toEqual(["http", "soap", "connect"]);
    expect(summaries[0]).toMatchObject({
      kind: "http", method: "GET", path: "/mlo/MLOInetSync.asmx", queryKeys: ["WSDL"], status: 200,
    });
    expect(summaries[1]).toMatchObject({
      kind: "soap",
      operation: "GetChanges",
      soapAction: "http://mlo.example/GetChanges",
      requestFields: ["fromVersion", "profile"],
      status: 200,
      responseOperation: "GetChangesResponse",
      responseFields: ["GetChangesResult", "serverVersion", "<sensitive-field>"],
    });
    expect(summaries[2]).toMatchObject({ kind: "connect", target: `127.0.0.1:${upstreamPort}` });
    const raw = await fs.readFile(path.join(dir, SUMMARY_FILE), "utf8");
    expect(raw).not.toContain("zipbytes");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("p9");
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });

  it("does not summarize traffic to other hosts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-observe-")); dirs.push(dir);
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/xml" });
      response.end(SOAP_RESPONSE);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    // observeHost keeps its vendor default, so 127.0.0.1 traffic is not recorded
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateRoot: dir });
    handles.push(handle);

    await new Promise<void>((resolve, reject) => {
      const request = http.request({
        host: handle.host, port: handle.port, method: "GET",
        path: `http://127.0.0.1:${upstreamPort}/mlo/MLOInetSync.asmx`,
      }, (response) => { response.resume(); response.on("end", resolve); });
      request.on("error", reject);
      request.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fs.readFile(path.join(dir, SUMMARY_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });
});

import http, { type RequestListener } from "node:http";
import { gzipSync, deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { decodeForwardBody, forwardBuffered } from "../../src/cloud/upstream.js";

const servers: http.Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

async function listen(handler: RequestListener): Promise<URL> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return new URL(`http://127.0.0.1:${address.port}/soap`);
}

it("strips proxy and connection-scoped headers while preserving SOAP bytes and end-to-end headers", async () => {
  let received: http.IncomingHttpHeaders = {}, receivedBody = "";
  const target = await listen((req, res) => {
    received = req.headers;
    req.setEncoding("utf8");
    req.on("data", chunk => { receivedBody += chunk; });
    req.on("end", () => { res.writeHead(200, { "x-upstream": "ok" }); res.end("response"); });
  });
  const result = await forwardBuffered(target, "POST", {
    host: "old.invalid", "content-length": "999", soapaction: "GetModificationsBytesEx",
    authorization: "Bearer synthetic-upstream-token", "content-type": "text/xml",
    "proxy-authorization": "Basic synthetic-proxy-token", "proxy-connection": "keep-alive",
    connection: "X-Local-Secret, Host, Content-Length", "x-local-secret": "synthetic",
    "keep-alive": "timeout=999", te: "trailers", trailer: "x-trailer", upgrade: "websocket",
  }, Buffer.from("<soap>synthetic</soap>"));
  expect(result.status).toBe(200);
  expect(result.body.toString()).toBe("response");
  expect(result.headers["x-upstream"]).toBe("ok");
  expect(receivedBody).toBe("<soap>synthetic</soap>");
  expect(received.host).toBe(target.host);
  expect(received["content-length"]).toBe(String(Buffer.byteLength(receivedBody)));
  expect(received.soapaction).toBe("GetModificationsBytesEx");
  expect(received.authorization).toBe("Bearer synthetic-upstream-token");
  for (const key of ["proxy-authorization", "proxy-connection", "x-local-secret", "te", "trailer", "upgrade"])
    expect(received[key]).toBeUndefined();
  expect(received.connection).not.toContain("X-Local-Secret");
  expect(received["keep-alive"]).not.toBe("timeout=999");
});

it("rejects a buffered response larger than 32 MiB", async () => {
  const target = await listen((_req, res) => { res.end(Buffer.alloc(32 * 1024 * 1024 + 1)); });
  await expect(forwardBuffered(target, "POST", {}, Buffer.alloc(0))).rejects.toThrow(/size limit/);
});

it.each(["gzip", "deflate"])("bounds %s expansion while decoding ordinary responses unchanged", encoding => {
  const compress = encoding === "gzip" ? gzipSync : deflateSync;
  const result = { status: 200, headers: { "content-encoding": encoding }, body: compress(Buffer.from("<soap>ok</soap>")) };
  expect(decodeForwardBody(result)).toBe("<soap>ok</soap>");
  result.body = compress(Buffer.alloc(64 * 1024 * 1024 + 1));
  expect(() => decodeForwardBody(result)).toThrow();
});

it("enforces the absolute deadline even after response data starts arriving", async () => {
  let respond!: () => void;
  const arrived = new Promise<void>(resolve => { respond = resolve; });
  const target = await listen((_req, res) => { res.write("partial response"); respond(); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = forwardBuffered(target, "POST", {}, Buffer.alloc(0));
  const rejected = expect(pending).rejects.toThrow(/deadline/);
  await arrived;
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
});

it("returns redirects without following them", async () => {
  let followups = 0;
  const other = await listen((_req, res) => { followups++; res.end("unexpected"); });
  const target = await listen((_req, res) => { res.writeHead(302, { location: other.href }); res.end(); });
  const result = await forwardBuffered(target, "POST", {}, Buffer.alloc(0));
  expect(result.status).toBe(302);
  expect(followups).toBe(0);
});

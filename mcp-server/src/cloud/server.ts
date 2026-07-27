import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import { CloudGateway } from "./gateway.js";
import { SyncObserver } from "./sync-observer.js";
import { peekSoapFields, soapFault, soapOperationFailure, soapOperationFromAction } from "./soap.js";
import { forwardVendorSoap } from "./upstream.js";
import { captureTlsConnectSeen, captureVendorSession } from "./capture.js";
import { DEFAULT_CLOUD_PORT } from "../config.js";
import { SERVER_INFO } from "../version.js";
import { log } from "../log.js";

const BODY_LIMIT = 32 * 1024 * 1024;

/** Long enough for the shutdown response to reach the session waiting on it. */
const SHUTDOWN_GRACE_MS = 50;

export interface CloudServerOptions {
  host?: string;
  port?: number;
  /** Partition-aware routing; built from `stateRoot` when absent. */
  gateway?: CloudGateway;
  /** State root sugar for callers without a prebuilt gateway (tests). */
  stateRoot?: string;
  /** Hostname whose proxied traffic is structurally summarized (tests override the vendor default). */
  observeHost?: string;
}

export interface CloudServerHandle {
  server: http.Server;
  gateway: CloudGateway;
  host: string;
  port: number;
  stop(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error("request body exceeds 32 MiB"), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function xml(response: ServerResponse, status: number, body: Uint8Array): void {
  response.writeHead(status, {
    "content-type": "text/xml; charset=utf-8",
    "content-length": body.byteLength,
  });
  response.end(body);
}

function isAbsoluteRequestTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

async function interceptVendorSoap(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: CloudGateway,
  observer: SyncObserver,
): Promise<boolean> {
  if (request.method !== "POST") return false;
  let target: URL;
  try { target = new URL(request.url ?? ""); }
  catch { return false; }
  if (!observer.matches(target.hostname) || !/\/MLOInetSync\.asmx$/i.test(target.pathname)) return false;
  const operation = soapOperationFromAction(request.headers.soapaction);
  if (!operation) return false;

  const requestBytes = await readBytes(request);
  const exchange = observer.begin(request.method, target, request.headers);
  exchange.addRequestChunk(requestBytes);
  const fields = peekSoapFields(requestBytes.toString("utf8"), operation);

  const authority = await gateway.decideAuthority(fields);
  if (authority.kind === "reject") {
    const responseBytes = soapOperationFailure(operation, authority.message);
    exchange.addResponseChunk(Buffer.from(responseBytes));
    exchange.finish(200, { "content-type": "text/xml; charset=utf-8" });
    xml(response, 200, responseBytes);
    return true;
  }
  try {
    const result = await forwardVendorSoap(gateway, target, request.headers, requestBytes, fields);
    exchange.addResponseChunk(result.body);
    exchange.finish(result.status, result.headers);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
    // After the response is on its way, never before: capture is a contained
    // tap (spec section 6) and must not add a millisecond to MLO's session.
    void captureVendorSession(gateway, operation, fields, result);
  } catch (error) {
    const message = `vendor forward failed: ${error instanceof Error ? error.message : String(error)}`;
    exchange.finish(502, {});
    xml(response, 502, soapFault(message));
  }
  return true;
}

function forwardRequest(request: IncomingMessage, response: ServerResponse, observer: SyncObserver): void {
  let target: URL;
  try {
    target = new URL(request.url ?? "");
  } catch {
    json(response, 400, { error: "invalid proxy request target" });
    return;
  }
  const transport = target.protocol === "https:" ? https : target.protocol === "http:" ? http : undefined;
  if (!transport) {
    json(response, 400, { error: "unsupported proxy protocol" });
    return;
  }
  const exchange = observer.matches(target.hostname)
    ? observer.begin(request.method ?? "GET", target, request.headers)
    : undefined;
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
  delete headers["proxy-connection"];
  const upstream = transport.request(target, { method: request.method, headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
    if (exchange) {
      upstreamResponse.on("data", (chunk: Buffer) => exchange.addResponseChunk(chunk));
      upstreamResponse.on("end", () => exchange.finish(upstreamResponse.statusCode, upstreamResponse.headers));
    }
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) json(response, 502, { error: `proxy request failed: ${error.message}` });
    else response.destroy(error);
  });
  request.on("aborted", () => upstream.destroy());
  if (exchange) request.on("data", (chunk: Buffer) => exchange.addRequestChunk(chunk));
  request.pipe(upstream);
}

function tunnelConnect(
  request: IncomingMessage,
  client: net.Socket,
  head: Buffer,
  observer: SyncObserver,
  gateway: CloudGateway,
): void {
  const separator = (request.url ?? "").lastIndexOf(":");
  const host = separator > 0 ? request.url!.slice(0, separator) : "";
  const port = Number(separator > 0 ? request.url!.slice(separator + 1) : "");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  if (observer.matches(host)) {
    observer.recordConnect(host, port);
    // TLS-tunneled vendor sync is invisible to the proxy: nothing can be
    // observed or injected. Loud, because the whole write path rides the
    // plain-HTTP forward.
    log('HTTPS CONNECT to the vendor sync host: sync is TLS-tunneled and invisible to the endpoint — uncheck "Use secure connection" in MLO\'s cloud login');
    void captureTlsConnectSeen(gateway, host, port);
  }
  const upstream = net.connect(port, host);
  upstream.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  client.once("error", () => upstream.destroy());
}

/**
 * Start the loopback endpoint. Under the resident model
 * ([ADR-0003](../../../docs/adr/0003-resident-endpoint.md)) its only callers
 * are the resident entrypoint and the tests: an MCP session never binds this
 * port, which is what keeps ownership from drifting back to "whoever started
 * first".
 */
export async function startCloudServer(options: CloudServerOptions): Promise<CloudServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "localhost" && host !== "::1" && !/^127(?:\.\d{1,3}){3}$/.test(host)) {
    throw new Error(`MLO cloud server must bind to a loopback host (received "${host}")`);
  }
  if (!options.gateway && !options.stateRoot) throw new Error("cloud server needs a gateway or a stateRoot");
  const gateway = options.gateway ?? new CloudGateway({ stateRoot: options.stateRoot! });
  const observer = new SyncObserver(gateway.observerDir(), options.observeHost);
  let stopped: Promise<void> | undefined;
  const server = http.createServer(async (request, response) => {
    try {
      if (isAbsoluteRequestTarget(request.url ?? "")) {
        if (await interceptVendorSoap(request, response, gateway, observer)) return;
        forwardRequest(request, response, observer);
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/v1/status") {
        json(response, 200, {
          stateRoot: gateway.stateRoot,
          partitions: await gateway.registry.list(),
          // The two fields attaching sessions read: the build (so a newer one
          // can replace a stale resident) and which cloud files this process
          // has seen sync traffic for.
          version: SERVER_INFO.version,
          contactUids: gateway.vendorContactUids(),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/shutdown") {
        // Answer first: the caller is a newer session waiting for the port.
        json(response, 200, { ok: true });
        setTimeout(
          () => void stopSelf().catch((error) => log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`)),
          SHUTDOWN_GRACE_MS,
        );
        return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on("connect", (request, socket, head) => tunnelConnect(request, socket as net.Socket, head, observer, gateway));

  /** Idempotent: /v1/shutdown and an explicit stop() must not race each other. */
  function stopSelf(): Promise<void> {
    stopped ??= (async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        // Keep-alive sockets from attached sessions would otherwise hold the
        // port open past close(), and a replacing session is waiting for it.
        server.closeAllConnections();
      });
      log("cloud server stopped");
    })();
    return stopped;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_CLOUD_PORT, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? DEFAULT_CLOUD_PORT;
  log(`cloud server listening on http://${host}:${port}`);
  return { server, gateway, host, port, stop: stopSelf };
}

export function stopCloudServer(handle: CloudServerHandle): Promise<void> {
  return handle.stop();
}

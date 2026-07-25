import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import { cursorToDecimalString, parseCursor } from "./cursor.js";
import { mergeDeltas } from "./delta.js";
import { packEnvelope, unpackEnvelope } from "./envelope.js";
import { CloudState, type DeltaOrigin } from "./state.js";
import { CloudGateway } from "./gateway.js";
import { SyncObserver } from "./sync-observer.js";
import { handleSoapRequest, peekSoapFields, soapFault, soapOperationFailure, soapOperationFromAction } from "./soap.js";
import { forwardVendorSoap } from "./upstream.js";
import { CredentialLender } from "./credential-lending.js";
import { SERVER_INFO } from "../version.js";
import { log } from "../log.js";

const BODY_LIMIT = 32 * 1024 * 1024;

/** Long enough for the shutdown response to reach the session waiting on it. */
const SHUTDOWN_GRACE_MS = 50;

/** Default listen port; off the crowded 8080 so dev servers don't collide with it. */
export const DEFAULT_CLOUD_PORT = 8181;

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
  /** The gateway's default (unbound) state; partition state is reached via `gateway`. */
  state: CloudState;
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
}

function xml(response: ServerResponse, status: number, body: Uint8Array): void {
  response.writeHead(status, {
    "content-type": "text/xml; charset=utf-8",
    "content-length": body.byteLength,
  });
  response.end(body);
}

function requiredString(body: Record<string, unknown>, name: string): string {
  if (typeof body[name] !== "string") throw Object.assign(new Error(`${name} must be a string`), { status: 400 });
  return body[name];
}

function decodeEnvelope(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw Object.assign(new Error("envelope must be valid base64"), { status: 400 });
  }
  return Buffer.from(value, "base64");
}

function clientOrigin(client: string): DeltaOrigin {
  return client === "mlo-app" ? "app" : "mcp";
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
  const requestXml = requestBytes.toString("utf8");
  const fields = peekSoapFields(requestXml, operation);

  // Mode dispatch: one authority per profile session. Upstream-bound (and
  // unknown, windowless) dataFileUIDs are forwarded to the vendor with the
  // response returned verbatim; everything else terminates locally.
  const authority = await gateway.decideAuthority(fields);
  if (authority.kind === "upstream") {
    try {
      const result = await forwardVendorSoap(gateway, authority.context, target, operation, request.headers, requestBytes, fields);
      exchange.addResponseChunk(result.body);
      exchange.finish(result.status, result.headers);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch (error) {
      const message = `vendor forward failed: ${error instanceof Error ? error.message : String(error)}`;
      exchange.finish(502, {});
      xml(response, 502, soapFault(message));
    }
    return true;
  }

  let responseBytes: Uint8Array;
  let status = 200;
  if (authority.kind === "reject") {
    responseBytes = soapOperationFailure(operation, authority.message);
  } else {
    try {
      responseBytes = await handleSoapRequest(gateway, operation, requestXml);
    } catch (error) {
      status = 500;
      responseBytes = soapFault(error instanceof Error ? error.message : String(error));
    }
  }
  exchange.addResponseChunk(Buffer.from(responseBytes));
  exchange.finish(status, { "content-type": "text/xml; charset=utf-8" });
  xml(response, status, responseBytes);
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

function tunnelConnect(request: IncomingMessage, client: net.Socket, head: Buffer, observer: SyncObserver, gateway: CloudGateway): void {
  const separator = (request.url ?? "").lastIndexOf(":");
  const host = separator > 0 ? request.url!.slice(0, separator) : "";
  const port = Number(separator > 0 ? request.url!.slice(separator + 1) : "");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  if (observer.matches(host)) {
    observer.recordConnect(host, port);
    // TLS-tunneled vendor sync would bypass the upstream mirror entirely.
    void gateway.noteVendorConnect().catch(() => undefined);
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
  const state = gateway.defaultState();
  const observer = new SyncObserver(gateway.observerDir(), options.observeHost);
  const lender = new CredentialLender(gateway);
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
        const [highWater, counts, pendingForApp] = await Promise.all([
          state.highWater(),
          state.counts(),
          state.pendingFor("app"),
        ]);
        json(response, 200, {
          cursor: cursorToDecimalString(highWater),
          entries: counts,
          pendingForApp,
          stateRoot: gateway.stateRoot,
          partitions: await gateway.registry.list(),
          // The two fields attaching sessions read: the build (so a newer one
          // can replace a stale resident) and which cloud files this process
          // can currently act as a client for.
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
      if (request.method === "POST" && url.pathname.startsWith("/v1/upstream/")) {
        await handleUpstream(response, url.pathname, await readJson(request));
        return;
      }
      if (request.method !== "POST" || !["/v1/pull", "/v1/push", "/v1/finalize"].includes(url.pathname)) {
        json(response, 404, { error: "not found" }); return;
      }
      const body = await readJson(request);
      const client = requiredString(body, "client");
      const rawUid = typeof body.dataFileUID === "string" && body.dataFileUID.length ? body.dataFileUID : undefined;
      let requestState: CloudState;
      try {
        requestState = await gateway.stateForV1(rawUid);
      } catch (error) {
        json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (url.pathname === "/v1/pull") {
        const cursor = parseCursor(requiredString(body, "cursor"));
        const origin = clientOrigin(client);
        const entries = await requestState.entriesAfter(cursor, origin);
        if (!entries.length) {
          const highWater = await requestState.highWater();
          await requestState.recordPull(origin, highWater);
          json(response, 200, { cursor: cursorToDecimalString(highWater) });
        } else {
          const merged = mergeDeltas(entries.map((entry) => unpackEnvelope(entry.bytes)));
          const returned = entries.at(-1)!.cursor;
          await requestState.recordPull(origin, returned);
          json(response, 200, {
            cursor: cursorToDecimalString(returned),
            envelope: Buffer.from(packEnvelope(merged)).toString("base64"),
          });
        }
        return;
      }
      if (url.pathname === "/v1/push") {
        const baseline = parseCursor(requiredString(body, "baseline"));
        if (baseline > await requestState.highWater()) {
          json(response, 409, { error: "baseline is newer than the server high-water cursor" }); return;
        }
        const bytes = decodeEnvelope(requiredString(body, "envelope"));
        try { unpackEnvelope(bytes); }
        catch (error) { throw Object.assign(error as Error, { status: 400 }); }
        const cursor = await requestState.append(clientOrigin(client), bytes);
        json(response, 200, { cursor: cursorToDecimalString(cursor) });
        return;
      }
      await requestState.finalize();
      json(response, 200, { ok: true });
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on("connect", (request, socket, head) => tunnelConnect(request, socket as net.Socket, head, observer, gateway));

  /**
   * The credential-lending routes: the three vendor round trips an attached
   * MCP session cannot make for itself, because the contacts are captured in
   * THIS process's memory and never written down. Everything else a session
   * needs it already reaches through the shared state root.
   *
   * Unauthenticated by decision (ADR-0003): any local account can drive a
   * write through here.
   */
  async function handleUpstream(response: ServerResponse, pathname: string, body: Record<string, unknown>): Promise<void> {
    if (pathname === "/v1/upstream/refresh") {
      json(response, 200, await lender.begin(requiredString(body, "dataFileUID")));
      return;
    }
    if (pathname === "/v1/upstream/commit") {
      const envelope = decodeEnvelope(requiredString(body, "envelope"));
      json(response, 200, { version: await lender.commit(requiredString(body, "session"), envelope) });
      return;
    }
    if (pathname === "/v1/upstream/history") {
      const history = await lender.history(requiredString(body, "dataFileUID"));
      json(response, 200, { version: history.version, envelope: history.envelope.toString("base64") });
      return;
    }
    json(response, 404, { error: "not found" });
  }

  /** Idempotent: /v1/shutdown and an explicit stop() must not race each other. */
  function stopSelf(): Promise<void> {
    stopped ??= (async () => {
      await lender.close();
      await state.flush();
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
  return { server, state, gateway, host, port, stop: stopSelf };
}

export function stopCloudServer(handle: CloudServerHandle): Promise<void> {
  return handle.stop();
}

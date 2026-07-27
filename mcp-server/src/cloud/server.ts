import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import { CloudGateway } from "./gateway.js";
import { SyncObserver } from "./sync-observer.js";
import { AutoInitializer, systemAutoInitPorts } from "./auto-init.js";
import {
  GET_FILE_TS,
  isGetFileTsAction,
  peekSoapFields,
  soapFault,
  soapFieldText,
  soapOperationFailure,
  soapOperationFromAction,
} from "./soap.js";
import { forwardBuffered, forwardVendorSoap } from "./upstream.js";
import { captureTlsConnectSeen, captureVendorSession } from "./capture.js";
import { WritePath } from "./write-path.js";
import { PROBLEM_CONTENT_TYPE, problemBody, type Problem } from "./problem.js";
import { DEFAULT_CLOUD_PORT } from "../config.js";
import { SERVER_INFO } from "../version.js";
import { log } from "../log.js";

const BODY_LIMIT = 32 * 1024 * 1024;

/** Long enough for the shutdown response to reach the session waiting on it. */
const SHUTDOWN_GRACE_MS = 50;

/**
 * How long composing may hold a forwarded exchange. Generous next to the local
 * file reads and in-memory merge it covers, and far inside MLO's own sync
 * timeout: only a hung subsystem reaches it.
 */
const DEFAULT_INJECTION_BUDGET_MS = 2_000;

export interface CloudServerOptions {
  host?: string;
  port?: number;
  /** Partition-aware routing; built from `stateRoot` when absent. */
  gateway?: CloudGateway;
  /** State root sugar for callers without a prebuilt gateway (tests). */
  stateRoot?: string;
  /** Hostname whose proxied traffic is structurally summarized (tests override the vendor default). */
  observeHost?: string;
  /** TTL for accepted writes (spec section 2 mechanic 7); default 15 minutes. */
  writeTtlMs?: number;
  /** Injectable clock for the write path (tests drive TTL expiry with it). */
  now?: () => Date;
  /**
   * The guarded auto-initializer (spec section 5). Built from `mloExePath` when
   * absent; pass one to substitute its ports. Omitting both leaves the server
   * unable to bind itself — the shape the suites that only exercise forwarding
   * want.
   */
  autoInit?: AutoInitializer;
  /** Where mlo.exe lives, for the auto-init profile probe. */
  mloExePath?: string;
  /**
   * How long a forwarded exchange may wait on the best-effort composing step
   * before it is abandoned and the vendor's payload forwarded verbatim (spec
   * section 6: no subsystem may block or DELAY a forwarded exchange). Tests
   * shorten it to make the overrun deterministic.
   */
  injectionBudgetMs?: number;
}

export interface CloudServerHandle {
  server: http.Server;
  gateway: CloudGateway;
  /** The resident write path — exposed for in-process suites (sabotage, contract). */
  writePath: WritePath;
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

function problemJson(response: ServerResponse, status: number, problem: Problem): void {
  response.writeHead(status, { "content-type": `${PROBLEM_CONTENT_TYPE}; charset=utf-8` });
  response.end(problemBody(problem));
}

/**
 * A best-effort transform the forward path awaits, bounded. The invariant
 * (spec section 6) forbids a subsystem BLOCKING or DELAYING a forwarded
 * exchange as much as it forbids failing it, and a store that hangs is not a
 * store that throws — so a transform that overruns its budget is abandoned and
 * the vendor's payload goes out verbatim. The work is caught before the race:
 * the loser must never become an unhandled rejection.
 */
async function withinBudget(
  work: Promise<Uint8Array | undefined>,
  budgetMs: number,
  label: string,
): Promise<Uint8Array | undefined> {
  const guarded = work.catch((error) => {
    log(`${label} skipped (forward path unaffected): ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      log(`${label} abandoned after ${budgetMs} ms (forward path unaffected)`);
      resolve(undefined);
    }, budgetMs);
  });
  try {
    return await Promise.race([guarded, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function interceptVendorSoap(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: CloudGateway,
  observer: SyncObserver,
  writePath: WritePath,
  autoInit: AutoInitializer | undefined,
  injectionBudgetMs: number,
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
    let body = result.body;
    let headers: IncomingMessage["headers"] = result.headers;
    if (operation === "GetModificationsBytesEx") {
      // Injection is a best-effort transform whose mandatory fallback is the
      // vendor's original payload (spec section 6): any failure — or any
      // overrun — in here forwards verbatim, and MLO never learns the
      // difference.
      const enriched = await withinBudget(
        writePath.enrichGetResponse(fields, result),
        injectionBudgetMs,
        "injection",
      );
      if (enriched) {
        body = Buffer.from(enriched);
        // Fresh headers: the rebuilt body is neither compressed nor the
        // vendor's length.
        headers = { "content-type": "text/xml; charset=utf-8", "content-length": String(body.byteLength) };
      }
    }
    exchange.addResponseChunk(body);
    exchange.finish(result.status, headers);
    response.writeHead(result.status, headers);
    response.end(body);
    // After the response is on its way, never before: capture and Apply
    // observation are contained taps (spec section 6) and must not add a
    // millisecond to MLO's session. Their own try, so a tap that throws
    // SYNCHRONOUSLY cannot fall into the 502 arm below and try to answer an
    // already-answered request. Each awaited-nowhere promise carries its own
    // catch, because a rejection escapes this try.
    try {
      void captureVendorSession(gateway, operation, fields, result);
      if (operation === "ApplyModificationsBytesEx") {
        void writePath.observeApply(fields, result).catch((error) =>
          log(`apply observation failed (forward path unaffected): ${error instanceof Error ? error.message : String(error)}`));
      }
      if (operation === "ReleaseSyncSessionBytes") {
        writePath.observeRelease(fields);
        // The session is over, so this is the moment the endpoint is allowed to
        // talk to the vendor itself (spec section 5): bind if the guards pass,
        // and service a human's outstanding repull. Fire-and-forget, like every
        // other tap — a proxied sync must never wait on the cloud plane.
        void autoInit?.serviceAfterSession(soapFieldText(fields, "dataFileUID"))
          ?.catch((error) => log(`post-session cloud-plane service failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    } catch (error) {
      log(`post-response tap failed (MLO's answer already sent): ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    const message = `vendor forward failed: ${error instanceof Error ? error.message : String(error)}`;
    exchange.finish(502, {});
    xml(response, 502, soapFault(message));
  }
  return true;
}

/**
 * MLO's ~90 s background GetFileTS poll. Forwarded like any vendor exchange;
 * the write path may answer it advanced while the injection queue is
 * non-empty (the nudge, spec section 2 mechanic 4), verbatim otherwise.
 */
async function interceptGetFileTs(
  request: IncomingMessage,
  response: ServerResponse,
  observer: SyncObserver,
  writePath: WritePath,
  injectionBudgetMs: number,
): Promise<boolean> {
  if (request.method !== "POST") return false;
  let target: URL;
  try { target = new URL(request.url ?? ""); }
  catch { return false; }
  if (!observer.matches(target.hostname) || !/\/MLOInetSync\.asmx$/i.test(target.pathname)) return false;
  if (!isGetFileTsAction(request.headers.soapaction)) return false;

  const requestBytes = await readBytes(request);
  const exchange = observer.begin(request.method, target, request.headers);
  exchange.addRequestChunk(requestBytes);
  const fields = peekSoapFields(requestBytes.toString("utf8"), GET_FILE_TS);
  try {
    const result = await forwardBuffered(target, "POST", request.headers, requestBytes);
    let body = result.body;
    let headers: IncomingMessage["headers"] = result.headers;
    const nudged = await withinBudget(writePath.nudgeFileTs(fields, result), injectionBudgetMs, "GetFileTS nudge");
    if (nudged) {
      body = Buffer.from(nudged);
      headers = { "content-type": "text/xml; charset=utf-8", "content-length": String(body.byteLength) };
    }
    exchange.addResponseChunk(body);
    exchange.finish(result.status, headers);
    response.writeHead(result.status, headers);
    response.end(body);
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
  const autoInit = options.autoInit
    ?? (options.mloExePath ? new AutoInitializer(gateway, systemAutoInitPorts(gateway, options.mloExePath)) : undefined);
  const writePath = new WritePath(gateway, {
    ...(options.writeTtlMs !== undefined ? { ttlMs: options.writeTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(autoInit ? { autoInit } : {}),
  });
  const injectionBudgetMs = options.injectionBudgetMs ?? DEFAULT_INJECTION_BUDGET_MS;
  let stopped: Promise<void> | undefined;
  const server = http.createServer(async (request, response) => {
    try {
      if (isAbsoluteRequestTarget(request.url ?? "")) {
        if (await interceptVendorSoap(request, response, gateway, observer, writePath, autoInit, injectionBudgetMs)) return;
        if (await interceptGetFileTs(request, response, observer, writePath, injectionBudgetMs)) return;
        forwardRequest(request, response, observer);
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      // The complete non-proxy surface (spec section 4): POST /v1/write,
      // GET /v1/write/:id, GET /v1/status, POST /v1/shutdown. Nothing else —
      // every deleted route answers 404.
      if (request.method === "POST" && url.pathname === "/v1/write") {
        let parsed: Record<string, unknown> | undefined;
        try {
          const value = JSON.parse((await readBytes(request)).toString("utf8")) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch { /* refused below */ }
        if (!parsed) {
          problemJson(response, 400, {
            kind: "invalid-request",
            title: "the write body must be a JSON object",
            retryable: false,
          });
          return;
        }
        const outcome = await writePath.accept(parsed.profile, parsed.rows);
        if (outcome.kind === "refused") {
          problemJson(response, outcome.httpStatus, outcome.problem);
          return;
        }
        json(response, 200, {
          writeId: outcome.writeId,
          uid: outcome.uid,
          verb: outcome.verb,
          ...(outcome.caption ? { caption: outcome.caption } : {}),
          status: "accepted",
          expiresAt: outcome.expiresAt,
        });
        return;
      }
      const writeStatusMatch = url.pathname.match(/^\/v1\/write\/([^/]+)$/);
      if (request.method === "GET" && writeStatusMatch) {
        const writeId = decodeURIComponent(writeStatusMatch[1]!);
        const lookup = await writePath.status(writeId);
        if (!lookup) {
          problemJson(response, 404, {
            kind: "unknown-write",
            title: `no write with id "${writeId}" — receipts age out of the outcome ring eventually`,
            retryable: false,
          });
          return;
        }
        json(response, 200, lookup);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/status") {
        json(response, 200, {
          stateRoot: gateway.stateRoot,
          partitions: await gateway.registry.list(),
          // The two fields attaching sessions read: the build (so a newer one
          // can replace a stale resident) and which cloud files this process
          // has seen sync traffic for.
          version: SERVER_INFO.version,
          contactUids: gateway.vendorContactUids(),
          // The one write-path fact that lives nowhere but this process: which
          // injected writes an MLO sync session has held unresolved long enough
          // to read as stalled. Everything else about a write is in the state
          // root, which sessions read for themselves.
          writesHeldOpen: writePath.writesHeldOpen(),
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
  return { server, gateway, writePath, host, port, stop: stopSelf };
}

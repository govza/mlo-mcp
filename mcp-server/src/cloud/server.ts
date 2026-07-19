import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import { cursorToDecimalString, parseCursor } from "./cursor.js";
import { mergeDeltas } from "./delta.js";
import { packEnvelope, unpackEnvelope } from "./envelope.js";
import { CloudState, type DeltaOrigin } from "./state.js";
import { log } from "../log.js";

const BODY_LIMIT = 32 * 1024 * 1024;

export interface CloudServerOptions {
  host?: string;
  port?: number;
  stateDir: string;
  state?: CloudState;
}

export interface CloudServerHandle {
  server: http.Server;
  state: CloudState;
  host: string;
  port: number;
  stop(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error("request body exceeds 32 MiB"), { status: 413 });
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
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

function forwardRequest(request: IncomingMessage, response: ServerResponse): void {
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
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
  delete headers["proxy-connection"];
  const upstream = transport.request(target, { method: request.method, headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) json(response, 502, { error: `proxy request failed: ${error.message}` });
    else response.destroy(error);
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function tunnelConnect(request: IncomingMessage, client: net.Socket, head: Buffer): void {
  const separator = (request.url ?? "").lastIndexOf(":");
  const host = separator > 0 ? request.url!.slice(0, separator) : "";
  const port = Number(separator > 0 ? request.url!.slice(separator + 1) : "");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
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

export async function startCloudServer(options: CloudServerOptions): Promise<CloudServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const state = options.state ?? new CloudState(options.stateDir);
  const server = http.createServer(async (request, response) => {
    try {
      if (isAbsoluteRequestTarget(request.url ?? "")) {
        forwardRequest(request, response);
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/v1/status") {
        const [highWater, counts, pendingForApp] = await Promise.all([
          state.highWater(),
          state.counts(),
          state.pendingFor("app"),
        ]);
        json(response, 200, { cursor: cursorToDecimalString(highWater), entries: counts, pendingForApp });
        return;
      }
      if (request.method !== "POST" || !["/v1/pull", "/v1/push", "/v1/finalize"].includes(url.pathname)) {
        json(response, 404, { error: "not found" }); return;
      }
      const body = await readJson(request);
      const client = requiredString(body, "client");
      if (url.pathname === "/v1/pull") {
        const cursor = parseCursor(requiredString(body, "cursor"));
        const origin = clientOrigin(client);
        const entries = await state.entriesAfter(cursor, origin);
        if (!entries.length) {
          const highWater = await state.highWater();
          await state.recordPull(origin, highWater);
          json(response, 200, { cursor: cursorToDecimalString(highWater) });
        } else {
          const merged = mergeDeltas(entries.map((entry) => unpackEnvelope(entry.bytes)));
          const returned = entries.at(-1)!.cursor;
          await state.recordPull(origin, returned);
          json(response, 200, {
            cursor: cursorToDecimalString(returned),
            envelope: Buffer.from(packEnvelope(merged)).toString("base64"),
          });
        }
        return;
      }
      if (url.pathname === "/v1/push") {
        const baseline = parseCursor(requiredString(body, "baseline"));
        if (baseline > await state.highWater()) {
          json(response, 409, { error: "baseline is newer than the server high-water cursor" }); return;
        }
        const bytes = decodeEnvelope(requiredString(body, "envelope"));
        try { unpackEnvelope(bytes); }
        catch (error) { throw Object.assign(error as Error, { status: 400 }); }
        const cursor = await state.append(clientOrigin(client), bytes);
        json(response, 200, { cursor: cursorToDecimalString(cursor) });
        return;
      }
      await state.finalize();
      json(response, 200, { ok: true });
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on("connect", tunnelConnect);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 8080;
  log(`cloud server listening on http://${host}:${port}`);
  return {
    server, state, host, port,
    async stop() {
      await state.flush();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      log("cloud server stopped");
    },
  };
}

export function stopCloudServer(handle: CloudServerHandle): Promise<void> {
  return handle.stop();
}

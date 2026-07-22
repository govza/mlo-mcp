import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { parseCursor } from "./cursor.js";
import { unpackEnvelope } from "./envelope.js";
import { validateFullSnapshot } from "./snapshot-validate.js";
import type { SoapOperation } from "./soap.js";
import type { PartitionHandle } from "./partition.js";
import type { CloudGateway } from "./gateway.js";
import type { DeltaEntry } from "./state.js";
import type { SectionedCsv } from "./csv.js";
import { log } from "../log.js";

/**
 * Upstream mode: the endpoint is a TRANSPARENT proxy for the three vendor
 * sync operations — the vendor stays the only cursor authority, requests and
 * responses pass through byte-for-byte, and the mirror capture is strictly
 * passive. All three operations of one profile session belong to the same
 * authority; nothing here may generate, rebase, or adopt a cursor.
 */
export interface ForwardResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Stage-2 write-through seam (NOT implemented): merging pending MCP deltas
 * into MLO's own outbound Apply so the vendor assigns the real version and
 * MLO receives the records on its follow-up Get. Gated behind controlled
 * experiments on a disposable vendor profile — same-client echo behavior,
 * byte-exact vs materialized echo, repeated Apply per session, and whether a
 * merged extra row is accepted and applied. Do not enable without them.
 */
export interface UpstreamWriteThrough {
  mergeOutbound(pending: DeltaEntry[], outbound: SectionedCsv): SectionedCsv;
  onVendorAccepted(newServerTimeStamp: string): Promise<void>;
}

export async function forwardBuffered(
  target: URL,
  method: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Promise<ForwardResult> {
  const transport = target.protocol === "https:" ? https : http;
  const outgoing: OutgoingHttpHeaders = { ...headers, host: target.host, "content-length": body.byteLength };
  delete outgoing["proxy-connection"];
  delete outgoing["transfer-encoding"];
  return new Promise((resolve, reject) => {
    const request = transport.request(target, { method, headers: outgoing }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}

function decodeBody(result: ForwardResult): string {
  const encoding = (result.headers["content-encoding"] ?? "").toString().toLowerCase();
  if (encoding.includes("gzip")) return zlib.gunzipSync(result.body).toString("utf8");
  if (encoding.includes("deflate")) return zlib.inflateSync(result.body).toString("utf8");
  return result.body.toString("utf8");
}

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

/** Field values of `<operation>Response`, or undefined when absent/malformed. */
function responseFields(xml: string, operation: SoapOperation): Record<string, unknown> | undefined {
  try {
    const document = parser.parse(xml) as Record<string, unknown>;
    const body = (document.Envelope as Record<string, unknown> | undefined)?.Body;
    const node = (body as Record<string, unknown> | undefined)?.[`${operation}Response`];
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    return node as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function text(fields: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = fields?.[name];
  return typeof value === "string" && value.length ? value : undefined;
}

export interface UpstreamContext {
  partition?: PartitionHandle;
  /** Capture into the partition's mirror (bound upstream or armed window). */
  capture: boolean;
  /** An armed upstream bootstrap window is watching this flow. */
  bootstrapping: boolean;
}

/**
 * Forward one vendor sync operation and passively capture the flow. Capture
 * failures never alter what the client receives — the vendor's response is
 * returned verbatim in every case.
 */
export async function forwardVendorSoap(
  gateway: CloudGateway,
  context: UpstreamContext,
  target: URL,
  operation: SoapOperation,
  requestHeaders: IncomingHttpHeaders,
  requestBytes: Buffer,
  requestFields: Record<string, unknown>,
): Promise<ForwardResult> {
  const result = await forwardBuffered(target, "POST", requestHeaders, requestBytes);
  if (!context.capture || !context.partition || result.status !== 200) return result;
  try {
    await captureExchange(gateway, context, operation, requestFields, result);
  } catch (error) {
    log(`upstream mirror capture failed (response passed through unchanged): ${error instanceof Error ? error.message : String(error)}`);
    await gateway.noteMirrorUnhealthy();
  }
  return result;
}

async function captureExchange(
  gateway: CloudGateway,
  context: UpstreamContext,
  operation: SoapOperation,
  requestFields: Record<string, unknown>,
  result: ForwardResult,
): Promise<void> {
  const partition = context.partition!;
  const fields = responseFields(decodeBody(result), operation);
  if (text(fields, `${operation}Result`) !== "true") return;

  if (operation === "ApplyModificationsBytesEx") {
    const version = text(fields, "newServerTimeStamp");
    const data = typeof requestFields.data === "string" ? requestFields.data : undefined;
    if (!version || !data) return;
    const bytes = Buffer.from(data.replace(/\s+/g, ""), "base64");
    const document = unpackEnvelope(bytes); // validates the envelope shape
    await partition.mirrorState.appendAtCursor("app", bytes, parseCursor(version));
    if (context.bootstrapping) await tryCompleteBootstrap(gateway, partition, document, version);
    return;
  }

  if (operation === "GetModificationsBytesEx") {
    const version = text(fields, "maxVersion");
    const data = text(fields, "data");
    if (!version || !data) return;
    const bytes = Buffer.from(data.replace(/\s+/g, ""), "base64");
    const document = unpackEnvelope(bytes);
    await partition.mirrorState.appendAtCursor("mcp", bytes, parseCursor(version));
    // A vendor-authoritative re-sync may deliver the complete database in the
    // DOWNLOAD direction instead of the upload; either direction can seed the
    // mirror while a bootstrap window watches.
    if (context.bootstrapping) await tryCompleteBootstrap(gateway, partition, document, version);
  }
}

async function tryCompleteBootstrap(
  gateway: CloudGateway,
  partition: PartitionHandle,
  document: SectionedCsv,
  version: string,
): Promise<void> {
  const window = await gateway.bootstrap!.current();
  if (!window) return;
  const validation = validateFullSnapshot(document);
  if (!validation.ok) return; // ordinary incremental traffic — keep watching
  await partition.mirrorSnapshots.materialize(document, parseCursor(version));
  await gateway.bindings!.bindUid(window.profilePath, partition.uid);
  await partition.setLifecycle("ready");
  await gateway.bootstrap!.complete();
  log(`upstream mirror bootstrapped at vendor version ${version} (${validation.stats.tasks} tasks)`);
}

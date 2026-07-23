import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { cursorToDecimalString, parseCursor, ZERO_CURSOR, type CloudCursor } from "./cursor.js";
import { generateGuid } from "./delta.js";
import { unpackEnvelope } from "./envelope.js";
import { validateFullSnapshot } from "./snapshot-validate.js";
import type { SoapOperation } from "./soap.js";
import type { PartitionHandle } from "./partition.js";
import type { CloudGateway } from "./gateway.js";
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
 * The credential material and target the endpoint needs to act as a SECOND
 * SYNC CLIENT of the vendor cloud for one `dataFileUID` — the same
 * multi-client model the vendor serves for desktop + mobile. Captured
 * transiently from the profile's own proxied sync traffic; held strictly
 * in memory, never persisted, never logged.
 */
export interface VendorContact {
  target: URL;
  loginBytes: string;
  passwordBytes: string;
  additionalParams?: string;
  encoding?: string;
  seenAt: number;
}

const CONTACT_FIELDS = ["loginBytes", "passwordBytes", "additionalParams", "encoding"] as const;

export function contactFromRequest(target: URL, fields: Record<string, unknown>): VendorContact | undefined {
  const values: Partial<Record<(typeof CONTACT_FIELDS)[number], string>> = {};
  for (const name of CONTACT_FIELDS) {
    const value = fields[name];
    if (typeof value === "string" && value.length) values[name] = value;
  }
  if (!values.loginBytes || !values.passwordBytes) return undefined;
  return {
    target,
    loginBytes: values.loginBytes,
    passwordBytes: values.passwordBytes,
    ...(values.additionalParams ? { additionalParams: values.additionalParams } : {}),
    ...(values.encoding ? { encoding: values.encoding } : {}),
    seenAt: Date.now(),
  };
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
  /** Capture into the bound partition's mirror. */
  capture: boolean;
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
  // Remember how to reach the vendor as a client for this cloud file
  // (in-memory only) — this is what powers pull-bootstrap and MCP writes.
  const rawUid = typeof requestFields.dataFileUID === "string" ? requestFields.dataFileUID : undefined;
  const contact = contactFromRequest(target, requestFields);
  if (rawUid && contact) gateway.noteVendorContact(rawUid, contact);

  const result = await forwardBuffered(target, "POST", requestHeaders, requestBytes);
  if (!context.capture || !context.partition || result.status !== 200) return result;
  try {
    await captureExchange(context, operation, requestFields, result);
  } catch (error) {
    log(`upstream mirror capture failed (response passed through unchanged): ${error instanceof Error ? error.message : String(error)}`);
    await gateway.noteMirrorUnhealthy();
  }
  return result;
}

async function captureExchange(
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
    unpackEnvelope(bytes); // validates the envelope shape
    await partition.mirrorState.appendAtCursor("app", bytes, parseCursor(version));
    return;
  }

  if (operation === "GetModificationsBytesEx") {
    const version = text(fields, "maxVersion");
    const data = text(fields, "data");
    if (!version || !data) return;
    const bytes = Buffer.from(data.replace(/\s+/g, ""), "base64");
    unpackEnvelope(bytes);
    await partition.mirrorState.appendAtCursor("mcp", bytes, parseCursor(version));
  }
}


/* ------------------------------------------------------------------------- *
 * The endpoint as a vendor sync client.
 *
 * The vendor cloud is a multi-client system by design (desktop + mobile).
 * Acting as one more client is therefore the protocol-supported way to give
 * MCP a write path that keeps MLO, the vendor, and mobile in sync: pushes go
 * up in the endpoint's OWN sessions (the vendor assigns the real remote
 * version), and MLO receives them on its next QuickSync like any other
 * remote change. Nothing here invents, rebases, or compares cursors — the
 * vendor stays the single authority.
 * ------------------------------------------------------------------------- */

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const MLO_NAMESPACE = "http://www.mylifeorganized.net/";

export class VendorClient {
  constructor(
    readonly contact: VendorContact,
    readonly dataFileUID: string,
  ) {}

  private request(operation: SoapOperation, extra: [string, string][]): Promise<ForwardResult> {
    // Field order matches the observed desktop client (cloud-sync.md).
    const ordered: [string, string][] = operation === "ReleaseSyncSessionBytes"
      ? [
          ["loginBytes", this.contact.loginBytes],
          ["passwordBytes", this.contact.passwordBytes],
          ...(this.contact.encoding ? [["encoding", this.contact.encoding] as [string, string]] : []),
          ["dataFileUID", this.dataFileUID],
          ...extra,
        ]
      : [
          ["loginBytes", this.contact.loginBytes],
          ["passwordBytes", this.contact.passwordBytes],
          ...(this.contact.additionalParams ? [["additionalParams", this.contact.additionalParams] as [string, string]] : []),
          ...extra.filter(([name]) => name === "sessionID"),
          ...(this.contact.encoding ? [["encoding", this.contact.encoding] as [string, string]] : []),
          ["dataFileUID", this.dataFileUID],
          ...extra.filter(([name]) => name !== "sessionID"),
        ];
    const body = ordered.map(([name, value]) => `<${name}>${xmlEscape(value)}</${name}>`).join("");
    const xml = `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soap:Body><${operation} xmlns="${MLO_NAMESPACE}">${body}</${operation}></soap:Body></soap:Envelope>`;
    return forwardBuffered(this.contact.target, "POST", {
      "content-type": "text/xml; charset=utf-8",
      soapaction: `"${MLO_NAMESPACE}${operation}"`,
    }, Buffer.from(xml, "utf8"));
  }

  private parse(operation: SoapOperation, result: ForwardResult): Record<string, unknown> {
    if (result.status !== 200) throw new Error(`vendor ${operation} failed with HTTP ${result.status}`);
    const fields = responseFields(decodeBody(result), operation);
    if (text(fields, `${operation}Result`) !== "true") {
      const message = text(fields, "errorMessage") ?? "vendor reported failure";
      throw new Error(`vendor ${operation} rejected: ${message}`);
    }
    return fields!;
  }

  /** Pull all changes newer than `newerThan`; returns the vendor version and payload. */
  async pull(sessionId: string, newerThan: CloudCursor): Promise<{ maxVersion: CloudCursor; data?: Buffer }> {
    const fields = this.parse("GetModificationsBytesEx", await this.request("GetModificationsBytesEx", [
      ["sessionID", sessionId],
      ["newerThan", cursorToDecimalString(newerThan)],
    ]));
    const maxVersion = parseCursor(text(fields, "maxVersion") ?? "0");
    const data = text(fields, "data");
    return { maxVersion, ...(data ? { data: Buffer.from(data.replace(/\s+/g, ""), "base64") } : {}) };
  }

  /** Upload one envelope; the vendor assigns and returns the new remote version. */
  async apply(sessionId: string, envelope: Uint8Array): Promise<CloudCursor> {
    const fields = this.parse("ApplyModificationsBytesEx", await this.request("ApplyModificationsBytesEx", [
      ["sessionID", sessionId],
      // Opaque local baseline of THIS client; zero mirrors a first-sync
      // client, which the vendor demonstrably accepts.
      ["lastSyncTimestamp", "0"],
      ["data", Buffer.from(envelope).toString("base64")],
    ]));
    return parseCursor(text(fields, "newServerTimeStamp") ?? "0");
  }

  async release(sessionId: string): Promise<void> {
    this.parse("ReleaseSyncSessionBytes", await this.request("ReleaseSyncSessionBytes", [["sessionID", sessionId]]));
  }
}

/**
 * Bootstrap an upstream mirror WITHOUT touching the MLO UI: pull the vendor's
 * complete history from remote version 0 as a client, validate it as a full
 * snapshot (full by construction, so `Config` is not required), materialize
 * it, and bind the profile. Requires a contact captured from the profile's
 * own sync traffic since server start.
 */
export async function bootstrapFromVendor(
  gateway: CloudGateway,
  profilePath: string,
  rawUid: string,
): Promise<{ version: string; stats: Record<string, number> }> {
  const contact = gateway.vendorContact(rawUid);
  if (!contact) {
    throw new Error(
      "no vendor sync credentials observed for this dataFileUID yet — run one sync in MLO through this proxy, then retry",
    );
  }
  const partition = await gateway.registry.open(rawUid, "upstream");
  const client = new VendorClient(contact, partition.uid);
  const sessionId = generateGuid();
  const pulled = await client.pull(sessionId, ZERO_CURSOR);
  await client.release(sessionId).catch(() => undefined);
  if (!pulled.data) throw new Error("vendor returned no payload for a full-history pull");
  const document = unpackEnvelope(pulled.data);
  const validation = validateFullSnapshot(document, { requireConfig: false });
  if (!validation.ok) {
    const preview = validation.errors.slice(0, 5).join("; ");
    throw new Error(`vendor full-history pull failed snapshot validation: ${preview}`);
  }
  await partition.mirrorState.appendAtCursor("mcp", pulled.data, pulled.maxVersion);
  await partition.mirrorSnapshots.materialize(document, pulled.maxVersion);
  await gateway.bindings.bindUid(profilePath, partition.uid);
  await partition.setLifecycle("ready");
  log(`upstream mirror bootstrapped from vendor history at version ${cursorToDecimalString(pulled.maxVersion)} (${validation.stats.tasks} tasks)`);
  return { version: cursorToDecimalString(pulled.maxVersion), stats: validation.stats };
}

/**
 * A write session against the vendor: refresh the mirror first (so full-row
 * authoring never starts from stale rows), then commit the MCP delta in the
 * endpoint's own vendor session. After the commit, MLO's next QuickSync
 * delivers the change back to the app like any other remote edit.
 */
export class UpstreamWriteSession {
  private readonly client: VendorClient;
  private readonly sessionId = generateGuid();

  constructor(
    readonly partition: PartitionHandle,
    contact: VendorContact,
  ) {
    this.client = new VendorClient(contact, partition.uid);
  }

  /** Pull vendor changes newer than the mirror and capture them. */
  async refresh(): Promise<void> {
    const newerThan = await this.partition.mirrorState.highWater();
    const pulled = await this.client.pull(this.sessionId, newerThan);
    if (pulled.data && pulled.maxVersion > newerThan) {
      unpackEnvelope(pulled.data);
      await this.partition.mirrorState.appendAtCursor("mcp", pulled.data, pulled.maxVersion);
    }
  }

  /** Upload one MCP-authored envelope; returns the vendor-assigned version. */
  async commit(envelope: Uint8Array): Promise<string> {
    const version = await this.client.apply(this.sessionId, envelope);
    await this.partition.mirrorState.appendAtCursor("mcp", envelope, version);
    await this.client.release(this.sessionId).catch(() => undefined);
    return cursorToDecimalString(version);
  }
}

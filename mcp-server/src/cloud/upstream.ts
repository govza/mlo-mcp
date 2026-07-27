import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { cursorToDecimalString, parseCursor, ZERO_CURSOR, type CloudCursor } from "./cursor.js";
import { generateGuid } from "./guid.js";
import { SECTION_HEADERS } from "./mlo-schema.js";
import { findSection, parseSectionedCsv, type SectionedCsv } from "./csv.js";
import { packEnvelope, unpackEnvelope } from "./envelope.js";
import { soapFieldText, type SoapOperation } from "./soap.js";
import type { CloudGateway } from "./gateway.js";

/**
 * The endpoint is a TRANSPARENT proxy for the three vendor sync operations —
 * the vendor stays the only cursor authority, and requests and responses pass
 * through byte-for-byte. All three operations of one profile session belong
 * to the same authority; nothing here may generate, rebase, or adopt a
 * cursor.
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

/** The forwarded body as text, undoing the vendor's transfer compression. */
export function decodeForwardBody(result: ForwardResult): string {
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
  return fields ? soapFieldText(fields, name) : undefined;
}

/**
 * Forward one vendor sync operation. The vendor's response is returned
 * verbatim in every case; the only side effect is remembering how to reach
 * the vendor as a client for this cloud file (in-memory only) — what powers
 * the bootstrap pull.
 */
export async function forwardVendorSoap(
  gateway: CloudGateway,
  target: URL,
  requestHeaders: IncomingHttpHeaders,
  requestBytes: Buffer,
  requestFields: Record<string, unknown>,
): Promise<ForwardResult> {
  const rawUid = typeof requestFields.dataFileUID === "string" ? requestFields.dataFileUID : undefined;
  const contact = contactFromRequest(target, requestFields);
  if (rawUid && contact) gateway.noteVendorContact(rawUid, contact);

  return forwardBuffered(target, "POST", requestHeaders, requestBytes);
}


/* ------------------------------------------------------------------------- *
 * The endpoint as a vendor sync client — initialization only.
 *
 * The vendor cloud is a multi-client system by design (desktop + mobile), so
 * acting as one more client is protocol-supported. Under ADR-0005 the
 * endpoint initiates vendor calls only during initialization (the guarded
 * auto-init full-history pull, or an explicit rebind/repull); in steady state
 * every vendor exchange is MLO-initiated and merely forwarded. Nothing here
 * invents, rebases, or compares cursors — the vendor stays the single
 * authority.
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

/**
 * Durable observation of one vendor-client exchange: operation, cursor values,
 * result flags and payload sizes — never credential fields, which are built
 * inside the request and never reach the observer. The resident endpoint logs
 * to stderr, which dies with the process; this is what a post-mortem of a
 * failed write reads instead.
 */
export type VendorExchangeObserver = (record: Record<string, unknown>) => void | Promise<void>;

export class VendorClient {
  constructor(
    readonly contact: VendorContact,
    readonly dataFileUID: string,
    private readonly observe?: VendorExchangeObserver,
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

  /** One full round trip: send, observe durably, then enforce the result. */
  private async call(operation: SoapOperation, extra: [string, string][]): Promise<Record<string, unknown>> {
    const result = await this.request(operation, extra);
    const fields = result.status === 200 ? responseFields(decodeForwardBody(result), operation) : undefined;
    // Awaited so the record is on disk before any caller acts on the answer —
    // a refused commit must never outrun its own evidence.
    await this.note(operation, extra, result.status, fields);
    if (result.status !== 200) throw new Error(`vendor ${operation} failed with HTTP ${result.status}`);
    if (text(fields, `${operation}Result`) !== "true") {
      const message = text(fields, "errorMessage") ?? "vendor reported failure";
      throw new Error(`vendor ${operation} rejected: ${message}`);
    }
    return fields!;
  }

  private async note(
    operation: SoapOperation,
    extra: [string, string][],
    status: number,
    fields: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!this.observe) return;
    const request: Record<string, unknown> = {};
    for (const [name, value] of extra) {
      if (name === "data") request.dataBytes = value.length;
      else request[name] = value;
    }
    const optional = (name: string, key = name) => {
      const value = text(fields, name);
      return value ? { [key]: value } : {};
    };
    try {
      await this.observe({
        operation,
        dataFileUID: this.dataFileUID,
        request,
        status,
        ...(fields
          ? {
              result: text(fields, `${operation}Result`) ?? "<absent>",
              ...optional("errorMessage"),
              ...optional("newServerTimeStamp"),
              ...optional("maxVersion"),
              ...(text(fields, "data") ? { responseDataBytes: text(fields, "data")!.length } : {}),
            }
          : {}),
      });
    } catch {
      /* observation must never alter the exchange */
    }
  }

  /** Pull all changes newer than `newerThan`; returns the vendor version and payload. */
  async pull(sessionId: string, newerThan: CloudCursor): Promise<{ maxVersion: CloudCursor; data?: Buffer }> {
    const fields = await this.call("GetModificationsBytesEx", [
      ["sessionID", sessionId],
      ["newerThan", cursorToDecimalString(newerThan)],
    ]);
    const maxVersion = parseCursor(text(fields, "maxVersion") ?? "0");
    const data = text(fields, "data");
    return { maxVersion, ...(data ? { data: Buffer.from(data.replace(/\s+/g, ""), "base64") } : {}) };
  }

  /** Upload one envelope; the vendor assigns and returns the new remote version. */
  async apply(sessionId: string, envelope: Uint8Array): Promise<CloudCursor> {
    const fields = await this.call("ApplyModificationsBytesEx", [
      ["sessionID", sessionId],
      // Opaque local baseline of THIS client; zero mirrors a first-sync
      // client, which the vendor demonstrably accepts.
      ["lastSyncTimestamp", "0"],
      ["data", Buffer.from(envelope).toString("base64")],
    ]);
    const stamp = text(fields, "newServerTimeStamp");
    if (!stamp) {
      throw new Error(
        "vendor ApplyModificationsBytesEx answered success without a newServerTimeStamp — a malformed response, " +
          "so the upload cannot be trusted as stored",
      );
    }
    return parseCursor(stamp);
  }

  async release(sessionId: string): Promise<void> {
    await this.call("ReleaseSyncSessionBytes", [["sessionID", sessionId]]);
  }
}

/**
 * Pull the vendor's complete history from remote version 0 as one more client
 * — this runs in the resident endpoint, which is where the contact captured
 * from the profile's own sync traffic lives. Taking the contact as an
 * argument rather than reaching for it keeps that dependency visible in the
 * signature.
 */
export async function pullVendorHistory(
  contact: VendorContact,
  uid: string,
  observe?: VendorExchangeObserver,
): Promise<{ version: CloudCursor; envelope: Buffer }> {
  const client = new VendorClient(contact, uid, observe);
  const sessionId = generateGuid();
  const pulled = await client.pull(sessionId, ZERO_CURSOR);
  await client.release(sessionId).catch(() => undefined);
  if (!pulled.data) throw new Error("vendor returned no payload for a full-history pull");
  return { version: pulled.maxVersion, envelope: pulled.data };
}

/**
 * A vendor pull from version 0 uses a database-shaped raw CSV projection,
 * unlike ordinary Get responses and Apply requests, which use ZIP envelopes.
 * It contains all stable cloud columns, mixed with local database columns;
 * some empty cloud sections may be omitted and Places may omit Hotkey.
 *
 * Normalize that projection into the canonical cloud section/header order,
 * preserving every extra column and unknown section, and ZIP it so consumers
 * see one representation regardless of how the vendor supplied the history.
 * (No caller right now: the guarded auto-init pull materializes the row store
 * from this — ADR-0005 spec section 5.)
 */
export function normalizeVendorHistory(
  bytes: Uint8Array,
): { document: SectionedCsv; envelope: Uint8Array } {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return { document: unpackEnvelope(bytes), envelope: bytes };
  }

  let raw: SectionedCsv;
  try {
    raw = parseSectionedCsv(bytes);
  } catch (error) {
    throw new Error(
      "invalid vendor full-history payload: expected a ZIP envelope or raw sectioned CSV " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const canonicalNames = new Set<string>(SECTION_HEADERS.map(([name]) => name));
  const sections: SectionedCsv["sections"] = SECTION_HEADERS.map(([name, canonicalHeader]) => {
    const required: readonly string[] = canonicalHeader;
    const source = findSection(raw, name);
    if (!source) return { name, header: [...required], rows: [] };
    const extras = source.header.filter((column) => !required.includes(column));
    const header = [...required, ...extras];
    return {
      name,
      header,
      rows: source.rows.map((row) =>
        header.map((column) => {
          const index = source.header.indexOf(column);
          return index < 0 ? "" : row[index] ?? "";
        })
      ),
    };
  });
  sections.push(...raw.sections
    .filter((section) => !canonicalNames.has(section.name))
    .map((section) => ({
      name: section.name,
      header: [...section.header],
      rows: section.rows.map((row) => [...row]),
    })));
  const document = { sections };
  return { document, envelope: packEnvelope(document) };
}


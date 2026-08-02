import { XMLParser } from "fast-xml-parser";

const SOAP_NAMESPACE = "http://schemas.xmlsoap.org/soap/envelope/";
const MLO_NAMESPACE = "http://www.mylifeorganized.net/";

export const SOAP_OPERATIONS = [
  "GetModificationsBytesEx",
  "ApplyModificationsBytesEx",
  "ReleaseSyncSessionBytes",
] as const;

export type SoapOperation = typeof SOAP_OPERATIONS[number];

/**
 * The undocumented fourth operation: MLO's ~90 s background poll for the cloud
 * file's current version. Request carries `dataFileUID`; the response's
 * `GetFileTSResult` is the bare version number. Not a session operation — it
 * gates nothing by itself — but the write path answers it advanced while the
 * injection queue is non-empty, which is what induces a session for a
 * pure-MCP write on a quiet MLO (spec section 2, mechanic 4).
 */
export const GET_FILE_TS = "GetFileTS";

const OPERATIONS = new Set<string>(SOAP_OPERATIONS);
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function envelope(operation: string, fields: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="${SOAP_NAMESPACE}">` +
    `<soap:Body><${operation}Response xmlns="${MLO_NAMESPACE}">${fields}</${operation}Response></soap:Body></soap:Envelope>`;
  return new TextEncoder().encode(xml);
}

function field(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function parseFields(xml: string, expected: string): Record<string, unknown> {
  const document = parser.parse(xml) as Record<string, unknown>;
  const envelopeNode = document.Envelope;
  if (!envelopeNode || typeof envelopeNode !== "object") throw new Error("SOAP Envelope is missing");
  const body = (envelopeNode as Record<string, unknown>).Body;
  if (!body || typeof body !== "object") throw new Error("SOAP Body is missing");
  const operation = (body as Record<string, unknown>)[expected];
  if (operation === undefined) throw new Error(`SOAP Body does not contain ${expected}`);
  if (operation === "") return {};
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error(`${expected} fields are invalid`);
  }
  return operation as Record<string, unknown>;
}

/** Parsed operation fields for routing decisions; {} when the body is malformed. */
export function peekSoapFields(xml: string, operation: string): Record<string, unknown> {
  try {
    return parseFields(xml, operation);
  } catch {
    return {};
  }
}

/** Parsed `<operation>Response` fields; undefined when the body is malformed or carries no such response. */
export function peekSoapResponseFields(xml: string, operation: string): Record<string, unknown> | undefined {
  try {
    return parseFields(xml, `${operation}Response`);
  } catch {
    return undefined;
  }
}

/** A peeked field as non-empty text, or undefined. */
export function soapFieldText(fields: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = fields?.[name];
  return typeof value === "string" && value.length ? value : undefined;
}

/** A protocol-level failure envelope, for policy rejections outside the forward path. */
export function soapOperationFailure(operation: SoapOperation, message: string): Uint8Array {
  return envelope(operation, field(`${operation}Result`, "false") + field("errorMessage", message));
}

function actionName(action: string | string[] | undefined): string | undefined {
  const value = Array.isArray(action) ? action[0] : action;
  if (!value) return undefined;
  const normalized = value.trim().replace(/^"|"$/g, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function soapOperationFromAction(action: string | string[] | undefined): SoapOperation | undefined {
  const name = actionName(action);
  return name !== undefined && OPERATIONS.has(name) ? name as SoapOperation : undefined;
}

export function isGetFileTsAction(action: string | string[] | undefined): boolean {
  return actionName(action) === GET_FILE_TS;
}

/** A rebuilt GetFileTS response presenting `version` — the nudge's answer. */
export function buildGetFileTsResponse(version: string): Uint8Array {
  return envelope(GET_FILE_TS, field(`${GET_FILE_TS}Result`, version));
}

/**
 * A rebuilt Get response carrying an injected payload: the same three fields
 * every captured vendor answer carries, nothing else.
 */
export function buildGetModificationsResponse(maxVersion: string, dataBase64: string): Uint8Array {
  return envelope(
    "GetModificationsBytesEx",
    field("GetModificationsBytesExResult", "true") + field("maxVersion", maxVersion) + field("data", dataBase64),
  );
}

export function soapFault(message: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${SOAP_NAMESPACE}"><soap:Body><soap:Fault>` +
    field("faultcode", "soap:Client") + field("faultstring", message) +
    `</soap:Fault></soap:Body></soap:Envelope>`;
  return new TextEncoder().encode(xml);
}

import { XMLParser } from "fast-xml-parser";

const SOAP_NAMESPACE = "http://schemas.xmlsoap.org/soap/envelope/";
const MLO_NAMESPACE = "http://www.mylifeorganized.net/";

export const SOAP_OPERATIONS = [
  "GetModificationsBytesEx",
  "ApplyModificationsBytesEx",
  "ReleaseSyncSessionBytes",
] as const;

export type SoapOperation = typeof SOAP_OPERATIONS[number];

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

function envelope(operation: SoapOperation, fields: string): Uint8Array {
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
export function peekSoapFields(xml: string, operation: SoapOperation): Record<string, unknown> {
  try {
    return parseFields(xml, operation);
  } catch {
    return {};
  }
}

/** Parsed `<operation>Response` fields; {} when the body is malformed. */
export function peekSoapResponseFields(xml: string, operation: SoapOperation): Record<string, unknown> {
  try {
    return parseFields(xml, `${operation}Response`);
  } catch {
    return {};
  }
}

/** A peeked field as non-empty text, or undefined. */
export function soapFieldText(fields: Record<string, unknown>, name: string): string | undefined {
  const value = fields[name];
  return typeof value === "string" && value.length ? value : undefined;
}

/** A protocol-level failure envelope, for policy rejections outside the forward path. */
export function soapOperationFailure(operation: SoapOperation, message: string): Uint8Array {
  return envelope(operation, field(`${operation}Result`, "false") + field("errorMessage", message));
}

export function soapOperationFromAction(action: string | string[] | undefined): SoapOperation | undefined {
  const value = Array.isArray(action) ? action[0] : action;
  if (!value) return undefined;
  const normalized = value.trim().replace(/^"|"$/g, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return OPERATIONS.has(name) ? name as SoapOperation : undefined;
}

export function soapFault(message: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${SOAP_NAMESPACE}"><soap:Body><soap:Fault>` +
    field("faultcode", "soap:Client") + field("faultstring", message) +
    `</soap:Fault></soap:Body></soap:Envelope>`;
  return new TextEncoder().encode(xml);
}

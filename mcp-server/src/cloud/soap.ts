import { XMLParser } from "fast-xml-parser";
import { cursorToDecimalString, parseCursor, type CloudCursor } from "./cursor.js";
import { mergeDeltas, NEW_TASK_DEFAULTS } from "./delta.js";
import { findSection, type SectionedCsv } from "./csv.js";
import { packEnvelope, unpackEnvelope } from "./envelope.js";
import { CloudState } from "./state.js";

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

function successFields(operation: SoapOperation, extra = ""): string {
  return field(`${operation}Result`, "true") + extra;
}

function failureFields(operation: SoapOperation, error: string, extra = ""): string {
  return field(`${operation}Result`, "false") + field("errorMessage", error) + extra;
}

function parseFields(xml: string, expected: SoapOperation): Record<string, unknown> {
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

function requiredText(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error("data must be valid base64");
  }
  return Buffer.from(compact, "base64");
}

function prepareMcpDeltaForMlo(document: SectionedCsv): SectionedCsv {
  const tasks = findSection(document, "TodoItems");
  if (tasks) {
    for (const [column, value] of Object.entries(NEW_TASK_DEFAULTS)) {
      const index = tasks.header.indexOf(column);
      if (index >= 0) for (const row of tasks.rows) if (!row[index]) row[index] = value;
    }
  }
  return document;
}

export function soapOperationFromAction(action: string | string[] | undefined): SoapOperation | undefined {
  const value = Array.isArray(action) ? action[0] : action;
  if (!value) return undefined;
  const normalized = value.trim().replace(/^"|"$/g, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return OPERATIONS.has(name) ? name as SoapOperation : undefined;
}

export async function handleSoapOperation(
  state: CloudState,
  operation: SoapOperation,
  xml: string,
): Promise<Uint8Array> {
  const fields = parseFields(xml, operation);

  if (operation === "GetModificationsBytesEx") {
    const baseline = parseCursor(requiredText(fields, "newerThan"));
    await state.adoptInitialBaseline("app", baseline);
    const entries = await state.entriesAfter(baseline, "app");
    const cursor = entries.length ? entries.at(-1)!.cursor : await state.highWater();
    await state.recordPull("app", cursor);
    const documents = entries.map((entry) => {
      const document = unpackEnvelope(entry.bytes);
      return entry.origin === "mcp" ? prepareMcpDeltaForMlo(document) : document;
    });
    const document = entries.length ? mergeDeltas(documents) : mergeDeltas([]);
    const data = field("data", Buffer.from(packEnvelope(document)).toString("base64"));
    return envelope(operation, successFields(operation, field("maxVersion", cursorToDecimalString(cursor)) + data));
  }

  if (operation === "ApplyModificationsBytesEx") {
    const baseline = parseCursor(requiredText(fields, "lastSyncTimestamp"));
    await state.adoptInitialBaseline("app", baseline);
    const highWater = await state.highWater();
    if (baseline > highWater) {
      return envelope(operation, failureFields(
        operation,
        "lastSyncTimestamp is newer than the server high-water cursor",
        field("newServerTimeStamp", cursorToDecimalString(highWater)),
      ));
    }
    const encoded = fields.data;
    if (encoded !== undefined && typeof encoded !== "string") {
      return envelope(operation, failureFields(
        operation,
        "data must be base64 text",
        field("newServerTimeStamp", cursorToDecimalString(highWater)),
      ));
    }
    let cursor: CloudCursor = highWater;
    if (encoded) {
      try {
        const bytes = decodeBase64(encoded);
        unpackEnvelope(bytes);
        cursor = await state.append("app", bytes);
      } catch (error) {
        return envelope(operation, failureFields(
          operation,
          error instanceof Error ? error.message : String(error),
          field("newServerTimeStamp", cursorToDecimalString(highWater)),
        ));
      }
    }
    return envelope(operation, successFields(operation, field("newServerTimeStamp", cursorToDecimalString(cursor))));
  }

  await state.finalize();
  return envelope(operation, successFields(operation));
}

export function soapFault(message: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${SOAP_NAMESPACE}"><soap:Body><soap:Fault>` +
    field("faultcode", "soap:Client") + field("faultstring", message) +
    `</soap:Fault></soap:Body></soap:Envelope>`;
  return new TextEncoder().encode(xml);
}

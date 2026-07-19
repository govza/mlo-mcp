import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { IncomingHttpHeaders } from "node:http";
import { log } from "../log.js";

/**
 * Credential-safe observation of proxied vendor sync traffic.
 *
 * When MLO is configured to use the cloud server as its HTTP proxy
 * (docs/mcp-cloud.md), requests to the vendor sync host pass through
 * forwardRequest/tunnelConnect. This module records their *structure* —
 * operation and field names, status codes, SOAP actions — to
 * `<stateDir>/soap-summary.jsonl`, mirroring the mitmproxy addon
 * (scripts/inspect-cloud-capture.py). Field values are never written:
 * raw bodies stay in memory only long enough to extract tag names.
 */

export const VENDOR_SYNC_HOST = "sync.mylifeorganized.net";
export const SUMMARY_FILE = "soap-summary.jsonl";

/** Response field names matching this are masked, same as the mitmproxy addon. */
const SENSITIVE = /pass|credential|token|secret|session|cookie|email|user|login/i;

const BODY = /<(?:[\w.-]+:)?Body(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?Body\s*>/i;
const TAG = /<(?!\/)(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?>/gi;

/** Per-exchange body capture cap; parsing needs the SOAP Body, not attachments. */
const CAPTURE_LIMIT = 4 * 1024 * 1024;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First opening tag of the SOAP Body = the operation; tags inside it = its fields. */
export function operationShape(xml: string): { operation: string; fields: string[] } {
  const body = BODY.exec(xml)?.[1] ?? "";
  const first = body.matchAll(TAG).next().value;
  if (!first) return { operation: "<unknown>", fields: [] };
  const operation = first[1]!;
  const rest = body.slice(first.index + first[0].length);
  const close = new RegExp(`</(?:[\\w.-]+:)?${escapeRegExp(operation)}\\s*>`, "i").exec(rest);
  const inner = close ? rest.slice(0, close.index) : rest;
  const fields: string[] = [];
  for (const match of inner.matchAll(TAG)) if (!fields.includes(match[1]!)) fields.push(match[1]!);
  return { operation, fields };
}

export function maskSensitiveField(field: string): string {
  return SENSITIVE.test(field) ? "<sensitive-field>" : field;
}

function decodeBody(chunks: Buffer[], contentEncoding: string | undefined): string {
  const raw = Buffer.concat(chunks);
  try {
    const encoding = (contentEncoding ?? "").toLowerCase();
    if (encoding.includes("gzip")) return zlib.gunzipSync(raw).toString("utf8");
    if (encoding.includes("deflate")) {
      try {
        return zlib.inflateSync(raw).toString("utf8");
      } catch {
        return zlib.inflateRawSync(raw).toString("utf8");
      }
    }
    return raw.toString("utf8");
  } catch {
    return "";
  }
}

class SyncExchange {
  private readonly requestChunks: Buffer[] = [];
  private readonly responseChunks: Buffer[] = [];
  private requestSize = 0;
  private responseSize = 0;
  private truncated = false;

  constructor(
    private readonly observer: SyncObserver,
    private readonly method: string,
    private readonly url: URL,
    private readonly requestHeaders: IncomingHttpHeaders
  ) {}

  private add(chunks: Buffer[], size: number, chunk: Buffer): number {
    if (size + chunk.length > CAPTURE_LIMIT) {
      this.truncated = true;
      return size;
    }
    chunks.push(chunk);
    return size + chunk.length;
  }

  addRequestChunk(chunk: Buffer): void {
    this.requestSize = this.add(this.requestChunks, this.requestSize, chunk);
  }

  addResponseChunk(chunk: Buffer): void {
    this.responseSize = this.add(this.responseChunks, this.responseSize, chunk);
  }

  finish(status: number | undefined, responseHeaders: IncomingHttpHeaders): void {
    const contentType = responseHeaders["content-type"] ?? "";
    if (contentType.includes("xml")) {
      const request = operationShape(decodeBody(this.requestChunks, this.requestHeaders["content-encoding"]));
      const response = operationShape(decodeBody(this.responseChunks, responseHeaders["content-encoding"] as string | undefined));
      this.observer.append({
        kind: "soap",
        operation: request.operation,
        soapAction: String(this.requestHeaders.soapaction ?? "").replace(/^"|"$/g, ""),
        requestFields: request.fields,
        status,
        responseOperation: response.operation,
        responseFields: response.fields.map(maskSensitiveField),
        ...(this.truncated ? { truncated: true } : {}),
      });
    } else {
      // Names only: the path and query *keys* are structure, query values are not.
      this.observer.append({
        kind: "http",
        method: this.method,
        path: this.url.pathname,
        ...(this.url.search ? { queryKeys: [...this.url.searchParams.keys()] } : {}),
        status,
        contentType,
      });
    }
  }
}

export class SyncObserver {
  private announcedConnect = false;

  constructor(
    private readonly stateDir: string,
    readonly host: string = VENDOR_SYNC_HOST
  ) {}

  matches(hostname: string): boolean {
    return hostname.toLowerCase() === this.host.toLowerCase();
  }

  /**
   * A CONNECT to the sync host means the app tunnels sync over TLS, so the
   * plain-HTTP observer sees nothing — that fact itself is the finding
   * (docs/mitm-proxy.md covers TLS interception).
   */
  recordConnect(host: string, port: number): void {
    if (!this.announcedConnect) {
      this.announcedConnect = true;
      log(`sync observer: HTTPS CONNECT to ${host}:${port} — vendor sync is TLS-tunneled; see docs/mitm-proxy.md`);
    }
    this.append({ kind: "connect", target: `${host}:${port}` });
  }

  begin(method: string, url: URL, requestHeaders: IncomingHttpHeaders): SyncExchange {
    return new SyncExchange(this, method, url, requestHeaders);
  }

  append(record: Record<string, unknown>): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    void fs
      .mkdir(this.stateDir, { recursive: true })
      .then(() => fs.appendFile(path.join(this.stateDir, SUMMARY_FILE), line))
      .catch((error) => log(`sync observer write failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

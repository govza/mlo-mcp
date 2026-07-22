import { cursorToDecimalString, parseCursor, type CloudCursor } from "./cursor.js";
import type { SectionedCsv } from "./csv.js";
import { unpackEnvelope } from "./envelope.js";
import { DEFAULT_CLOUD_PORT } from "./server.js";

export interface CloudClientOptions {
  baseUrl?: string;
  client?: string;
  /** Address a specific state partition; omitted = the server's default (legacy/bound) state. */
  dataFileUID?: string;
}
export interface CloudStatus { cursor: string; entries: { mcp: number; app: number }; pendingForApp: number }
export interface CloudPullResult { cursor: CloudCursor; sections?: SectionedCsv }
interface CursorResponse { cursor: string; envelope?: string }

export class CloudClient {
  readonly baseUrl: string;
  readonly client: string;
  readonly dataFileUID?: string;
  constructor(options: CloudClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? `http://127.0.0.1:${DEFAULT_CLOUD_PORT}`).replace(/\/$/, "");
    this.client = options.client ?? "mlo-app";
    this.dataFileUID = options.dataFileUID;
  }
  private addressed(body: Record<string, unknown>): Record<string, unknown> {
    return this.dataFileUID ? { ...body, dataFileUID: this.dataFileUID } : body;
  }
  status(): Promise<CloudStatus> { return this.request<CloudStatus>("/v1/status"); }
  async pull(cursor: CloudCursor): Promise<CloudPullResult> {
    const response = await this.request<CursorResponse>("/v1/pull", this.addressed({ client: this.client, cursor: cursorToDecimalString(cursor) }));
    const next = parseCursor(response.cursor);
    return response.envelope ? { cursor: next, sections: unpackEnvelope(Buffer.from(response.envelope, "base64")) } : { cursor: next };
  }
  async push(zipBytes: Uint8Array, baseline: CloudCursor): Promise<CloudCursor> {
    const response = await this.request<CursorResponse>("/v1/push", this.addressed({ client: this.client, baseline: cursorToDecimalString(baseline), envelope: Buffer.from(zipBytes).toString("base64") }));
    return parseCursor(response.cursor);
  }
  async finalize(): Promise<void> { await this.request("/v1/finalize", this.addressed({ client: this.client })); }
  private async request<T>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${route}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json() as { error?: unknown };
    if (!response.ok) {
      const message = typeof value.error === "string" ? value.error : response.statusText;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return value as T;
  }
}

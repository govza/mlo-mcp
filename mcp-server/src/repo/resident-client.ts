import { ensureEndpoint, type EndpointSpawner, type EndpointStatus } from "../cloud/endpoint.js";
import { parseProblem, type RehydratedProblem } from "../cloud/problem.js";
import { log } from "../log.js";
import type { DeltaRow, WriteId, WriteStatus } from "./mlo-repository.js";

/**
 * The HTTP hop to the resident write path — a named internal seam of the
 * MloRepository implementation (spec section 4), invisible above it.
 *
 * Refusals are values, never throws: non-2xx resident answers rehydrate from
 * problem+json (unknown kinds degrade to `kind: "unknown"`), and a resident
 * that cannot be reached at all is the typed retryable `endpoint-down`
 * refusal — never a spool, because a spooled "real-time" write is a stale
 * queued delta by the time it lands.
 *
 * Lazy attach-and-spawn: the client attaches — and spawns a resident, if the
 * port is free — on the call that needs it, not once at session start. That
 * kills the restart-the-client remedy class: a resident that died mid-session
 * comes back on the next write.
 */

export interface ResidentWrite {
  /** The profile whose bound partition carries the write. */
  profile: string;
  rows: DeltaRow[];
}

export interface AcceptedWrite {
  writeId: WriteId;
  uid: string;
  expiresAt: string;
}

/** One receipt's state as the resident answers it. */
export interface QueueState {
  writeId: WriteId;
  status: WriteStatus;
  uid?: string;
  expiresAt?: string;
  at?: string;
  detail?: string;
}

export type ResidentRefusal = RehydratedProblem;

export type ResidentResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: ResidentRefusal };

export interface ResidentClient {
  /** Durable accept: resolves only once the resident has fsync'd the rows. */
  postWrite(write: ResidentWrite): Promise<ResidentResult<AcceptedWrite>>;
  writeStatus(id: WriteId): Promise<ResidentResult<QueueState>>;
  /** Re-probe the resident; undefined means nothing answers right now. */
  probe(): Promise<EndpointStatus | undefined>;
}

export function endpointDownRefusal(detail: string): ResidentRefusal {
  return {
    kind: "endpoint-down",
    title: `the resident sync endpoint did not answer (${detail})`,
    retryable: true,
    remedy: "retry — the next call re-attaches, spawning a resident if the port is free",
    status: 0,
    extensions: {},
  };
}

const REQUEST_TIMEOUT_MS = 10_000;

export interface HttpResidentClientOptions {
  host: string;
  port: number;
  /** How a missing resident is started; absent means attach-only (tests). */
  spawn?: EndpointSpawner;
  startTimeoutMs?: number;
}

export class HttpResidentClient implements ResidentClient {
  constructor(private readonly options: HttpResidentClientOptions) {}

  private get url(): string {
    return `http://${this.options.host}:${this.options.port}`;
  }

  postWrite(write: ResidentWrite): Promise<ResidentResult<AcceptedWrite>> {
    return this.request<AcceptedWrite>("/v1/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(write),
    });
  }

  writeStatus(id: WriteId): Promise<ResidentResult<QueueState>> {
    return this.request<QueueState>(`/v1/write/${encodeURIComponent(id)}`, { method: "GET" });
  }

  async probe(): Promise<EndpointStatus | undefined> {
    try {
      const response = await fetch(`${this.url}/v1/status`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) return undefined;
      const body = await response.json() as Record<string, unknown>;
      return {
        ...(typeof body.version === "string" ? { version: body.version } : {}),
        contactUids: Array.isArray(body.contactUids)
          ? body.contactUids.filter((uid): uid is string => typeof uid === "string")
          : [],
        ...(typeof body.stateRoot === "string" ? { stateRoot: body.stateRoot } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async request<T>(route: string, init: RequestInit): Promise<ResidentResult<T>> {
    const first = await this.tryOnce<T>(route, init);
    if (first !== undefined) return first;
    // Nothing answered: attach-and-spawn, then one more attempt. ensureEndpoint
    // is the same startup path a session uses, so a free port gets a resident
    // and a foreign listener is reported rather than overwritten.
    if (this.options.spawn) {
      try {
        await ensureEndpoint({
          host: this.options.host,
          port: this.options.port,
          spawn: this.options.spawn,
          ...(this.options.startTimeoutMs !== undefined ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
        });
      } catch (error) {
        return { ok: false, refusal: endpointDownRefusal(error instanceof Error ? error.message : String(error)) };
      }
      const second = await this.tryOnce<T>(route, init);
      if (second !== undefined) return second;
    }
    return { ok: false, refusal: endpointDownRefusal(`no resident answers ${this.url}`) };
  }

  /** One HTTP attempt; undefined means the resident was unreachable. */
  private async tryOnce<T>(route: string, init: RequestInit): Promise<ResidentResult<T> | undefined> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${route}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      log(`resident endpoint unreachable at ${this.url}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      return { ok: false, refusal: parseProblem(response.status, bodyText) };
    }
    try {
      return { ok: true, value: JSON.parse(bodyText) as T };
    } catch {
      return {
        ok: false,
        refusal: {
          kind: "unknown",
          title: "the resident answered 200 without a JSON body",
          retryable: false,
          status: response.status,
          extensions: {},
        },
      };
    }
  }
}

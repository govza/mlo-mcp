import { parseProblem, problemBody, type Problem } from "../../src/cloud/problem.js";
import { describeWriteRows } from "../../src/cloud/write-path.js";
import type {
  AcceptedWrite,
  ResidentClient,
  ResidentResult,
  ResidentWrite,
} from "../../src/repo/resident-client.js";
import { endpointDownRefusal } from "../../src/repo/resident-client.js";
import type { EndpointStatus } from "../../src/cloud/endpoint.js";
import type { WriteId, WriteReceipt, WriteStatus } from "../../src/repo/mlo-repository.js";

/**
 * In-memory ResidentClient (spec section 8): accepts writes with hand-driven
 * five-state transitions, and refuses on script. Scripted refusals pass
 * through the REAL problem+json rehydration — including a `type` outside the
 * known set degrading to `kind: "unknown"` — so the fake cannot drift from
 * the wire behaviour the session client actually has.
 */
export class FakeResidentClient implements ResidentClient {
  writeTtlMs = 15 * 60_000;
  /** Every write this fake durably accepted, in order. */
  readonly accepted: (ResidentWrite & AcceptedWrite)[] = [];

  private readonly states = new Map<WriteId, WriteReceipt>();
  private nextWriteId = 1;
  private scripted: { httpStatus: number; body: string }[] = [];
  private down = false;

  /** The next call refuses with this problem, serialized and rehydrated for real. */
  refuseNextWith(httpStatus: number, problem: Problem): void {
    this.scripted.push({ httpStatus, body: problemBody(problem) });
  }

  /** The next call refuses with this raw non-2xx body (unknown types, non-JSON crashes). */
  refuseNextWithRaw(httpStatus: number, body: string): void {
    this.scripted.push({ httpStatus, body });
  }

  /** Everything refuses `endpoint-down` until the resident "comes back". */
  setDown(down: boolean): void {
    this.down = down;
  }

  /** Hand-drive a receipt through the five-state lifecycle. */
  transition(id: WriteId, status: WriteStatus, detail?: string): void {
    const state = this.states.get(id);
    if (!state) throw new Error(`unknown writeId "${id}"`);
    state.status = status;
    if (detail) state.detail = detail;
  }

  private refusal<T>(): ResidentResult<T> | undefined {
    if (this.down) return { ok: false, refusal: endpointDownRefusal("scripted: resident down") };
    const next = this.scripted.shift();
    if (!next) return undefined;
    return { ok: false, refusal: parseProblem(next.httpStatus, next.body) };
  }

  async postWrite(write: ResidentWrite): Promise<ResidentResult<AcceptedWrite>> {
    const refused = this.refusal<AcceptedWrite>();
    if (refused) return refused;
    const described = describeWriteRows(write.rows);
    if (!described) {
      return {
        ok: false,
        refusal: parseProblem(400, problemBody({
          kind: "invalid-request",
          title: "the rows carry no TodoItems row and no tombstone with a GUID-shaped UID",
          retryable: false,
        })),
      };
    }
    const value: AcceptedWrite = {
      writeId: `w${this.nextWriteId++}`,
      uid: described.uid,
      expiresAt: new Date(Date.now() + this.writeTtlMs).toISOString(),
    };
    this.accepted.push({ ...write, ...value });
    this.states.set(value.writeId, {
      writeId: value.writeId,
      status: "accepted",
      uid: value.uid,
      expiresAt: value.expiresAt,
    });
    return { ok: true, value };
  }

  async writeStatus(id: WriteId): Promise<ResidentResult<WriteReceipt>> {
    const refused = this.refusal<WriteReceipt>();
    if (refused) return refused;
    const state = this.states.get(id);
    if (!state) {
      return {
        ok: false,
        refusal: parseProblem(404, problemBody({
          kind: "unknown-write",
          title: `no write with id "${id}"`,
          retryable: false,
        })),
      };
    }
    return { ok: true, value: { ...state } };
  }

  async probe(): Promise<EndpointStatus | undefined> {
    return this.down ? undefined : { contactUids: [] };
  }
}

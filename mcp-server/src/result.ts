/**
 * Failures as values across every boundary ([spec section 6](../../docs/adr/0005-target-architecture-spec.md)).
 *
 * Plain tagged objects, no Result library: class identity dies at the HTTP
 * seam, so a refusal that travelled as an exception would arrive on the other
 * side as prose. Each boundary closes its own kind union over the central
 * table in `error-contract.ts`; genuine invariant violations stay exceptions.
 */

import type { Retryable } from "./cloud/problem.js";
import type { ContractKind } from "./error-contract.js";

export type ServiceResult<T, F extends Failure> =
  | { isErrored: false; value: T; advisories?: Advisory[] }
  | { isErrored: true; failure: F };

/** Every failure kind carries at least this much caller metadata. */
export interface Failure {
  kind: ContractKind;
  /** Producer-declared; nothing in this server retries automatically. */
  retryable: Retryable;
  /** What the caller (or the user) must do, named concretely. */
  remedy: string;
  detail: string;
  /**
   * The problem+json `type` verbatim, when the refusal crossed the HTTP seam.
   * Only worth reading for `unknown`, where it is the sole thing naming what
   * the other side actually refused with.
   */
  wireType?: string;
  /** The kind's typed fields as they arrived over the wire (RFC 9457 extension members). */
  fields?: Record<string, unknown>;
}

/**
 * Something the caller should know about a result that still succeeded — an
 * Event-tier observation riding along with the value, never a refusal.
 */
export interface Advisory {
  kind: ContractKind;
  detail: string;
}

export function ok<T>(value: T, advisories?: Advisory[]): { isErrored: false; value: T; advisories?: Advisory[] } {
  return advisories?.length ? { isErrored: false, value, advisories } : { isErrored: false, value };
}

export function failed<F extends Failure>(failure: F): { isErrored: true; failure: F } {
  return { isErrored: true, failure };
}

/**
 * The one place a failure becomes a sentence: `detail — remedy`, plus the wire
 * type when the kind degraded to `unknown` and that is all there is to name it.
 */
export function failureText(failure: Failure): string {
  const named = failure.kind === "unknown" && failure.wireType ? ` (${failure.wireType})` : "";
  return `${failure.detail}${named} — ${failure.remedy}`;
}

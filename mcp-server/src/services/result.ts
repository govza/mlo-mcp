/**
 * Failures as values across a service boundary (spec section 6). The full
 * treatment — one closed union per boundary, problem+json rehydration, the
 * four blast-radius tiers enforced by review gates — is ticket 10; this is the
 * carrier it generalizes, introduced here because OutlineService's refusals
 * (a row-store gap, an unresolvable id, a recurring task) are already typed
 * values that must not travel as exceptions.
 */
export type ServiceResult<T, F extends Failure> =
  | { isErrored: false; value: T }
  | { isErrored: true; failure: F };

/** Every failure kind carries at least this much caller metadata. */
export interface Failure {
  kind: string;
  /** Producer-declared; nothing in this server retries automatically. */
  retryable: boolean | "after-user-action";
  /** What the caller (or the user) must do, named concretely. */
  remedy: string;
  detail: string;
}

export function ok<T>(value: T): { isErrored: false; value: T } {
  return { isErrored: false, value };
}

export function failed<F extends Failure>(failure: F): { isErrored: true; failure: F } {
  return { isErrored: true, failure };
}

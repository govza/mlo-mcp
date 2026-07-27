import { expect } from "vitest";
import type { Failure, ServiceResult } from "../src/result.js";

/** Assert a boundary call succeeded and hand back its value. */
export function expectOk<T, F extends Failure>(result: ServiceResult<T, F>): T {
  if (result.isErrored) {
    expect.fail(`expected success, got ${result.failure.kind}: ${result.failure.detail}`);
  }
  return result.value;
}

/** Assert a boundary call refused, and hand back the typed failure. */
export function expectFailed<T, F extends Failure>(result: ServiceResult<T, F>): F {
  if (!result.isErrored) expect.fail("expected a typed refusal, got a value");
  return result.failure;
}

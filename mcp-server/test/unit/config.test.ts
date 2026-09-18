import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WRITE_WAIT_MS, resolveWriteWaitMs } from "../../src/config.js";

const original = process.env.MLO_WRITE_WAIT_MS;
afterEach(() => {
  if (original === undefined) delete process.env.MLO_WRITE_WAIT_MS;
  else process.env.MLO_WRITE_WAIT_MS = original;
});

describe("resolveWriteWaitMs", () => {
  it("keeps the default when the variable is unset", () => {
    delete process.env.MLO_WRITE_WAIT_MS;
    expect(resolveWriteWaitMs()).toBe(DEFAULT_WRITE_WAIT_MS);
  });

  it("keeps the default when the variable is blank", () => {
    process.env.MLO_WRITE_WAIT_MS = "  ";
    expect(resolveWriteWaitMs()).toBe(DEFAULT_WRITE_WAIT_MS);
  });

  it("honours an explicit 0 as return-at-accept", () => {
    process.env.MLO_WRITE_WAIT_MS = "0";
    expect(resolveWriteWaitMs()).toBe(0);
  });

  it("honours an explicit override", () => {
    process.env.MLO_WRITE_WAIT_MS = "5000";
    expect(resolveWriteWaitMs()).toBe(5000);
  });

  it("falls back on garbage", () => {
    process.env.MLO_WRITE_WAIT_MS = "soon";
    expect(resolveWriteWaitMs()).toBe(DEFAULT_WRITE_WAIT_MS);
  });
});

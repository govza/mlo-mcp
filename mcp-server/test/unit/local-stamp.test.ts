import { describe, expect, it } from "vitest";
import { localStampToString, parseLocalStamp } from "../../src/cloud/local-stamp.js";

describe("LocalStamp", () => {
  it("parses positive, zero, and negative signed 64-bit values", () => {
    expect(localStampToString(parseLocalStamp("24838"))).toBe("24838");
    expect(localStampToString(parseLocalStamp("0"))).toBe("0");
    expect(localStampToString(parseLocalStamp("-42"))).toBe("-42");
    expect(localStampToString(parseLocalStamp("9223372036854775807"))).toBe("9223372036854775807");
    expect(localStampToString(parseLocalStamp("-9223372036854775808"))).toBe("-9223372036854775808");
  });

  it("rejects non-integers and out-of-range values", () => {
    expect(() => parseLocalStamp("")).toThrow("invalid local sync stamp");
    expect(() => parseLocalStamp("1.5")).toThrow("invalid local sync stamp");
    expect(() => parseLocalStamp("abc")).toThrow("invalid local sync stamp");
    expect(() => parseLocalStamp("9223372036854775808")).toThrow("signed 64-bit range");
    expect(() => parseLocalStamp("-9223372036854775809")).toThrow("signed 64-bit range");
  });
});

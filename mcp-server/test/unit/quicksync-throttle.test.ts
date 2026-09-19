import { describe, expect, it } from "vitest";
import { delphiDateTimeToEpochMs, parseQuickSyncThrottle, quickSyncVerdict } from "../../src/repo/mlo-cli.js";

const regOutput = `
HKEY_CURRENT_USER\\Software\\MyLifeOrganized.net\\MyLife\\Settings
    LogEnabledSync    REG_DWORD    0x0
    QuickSyncCount    REG_DWORD    0x4
    QuickSyncTime    REG_BINARY    945853F68199E640
`;

describe("parseQuickSyncThrottle", () => {
  it("reads the counter and decodes the Delphi stamp as local wall-clock time", () => {
    const now = new Date(2026, 8, 19, 1, 30, 0);
    const throttle = parseQuickSyncThrottle(regOutput, now);
    expect(throttle?.count).toBe(4);
    // 46297.06131... days since 1899-12-30 = 2026-09-19 01:28:17 local
    expect(new Date(throttle!.lastInvokedAt!).toLocaleTimeString("en-GB")).toBe("01:28:17");
  });

  it("answers the counter alone when the stamp is missing or malformed", () => {
    expect(parseQuickSyncThrottle("    QuickSyncCount    REG_DWORD    0x2\n")).toEqual({ count: 2 });
    expect(parseQuickSyncThrottle("    QuickSyncCount    REG_DWORD    0x2\n    QuickSyncTime    REG_BINARY    9458\n")).toEqual({ count: 2 });
  });

  it("answers undefined without a counter", () => {
    expect(parseQuickSyncThrottle("ERROR: The system was unable to find the specified registry key or value.")).toBeUndefined();
    expect(delphiDateTimeToEpochMs("zz")).toBeUndefined();
  });
});

describe("quickSyncVerdict", () => {
  const budget = { maxPerWindow: 4, windowMs: 300_000 };
  const now = 1_000_000_000;

  it("is affordable under the budget regardless of the stamp", () => {
    expect(quickSyncVerdict({ count: 3 }, budget, now)).toEqual({ affordable: true });
  });

  it("is spent inside the window and says how long until the window slides past", () => {
    expect(quickSyncVerdict({ count: 4, lastInvokedAt: now - 100_000 }, budget, now)).toEqual({
      affordable: false,
      retryAfterMs: 200_000,
    });
  });

  it("is affordable again once the window has slid past the last invocation", () => {
    expect(quickSyncVerdict({ count: 4, lastInvokedAt: now - 300_000 }, budget, now)).toEqual({ affordable: true });
  });

  it("never spends a stale-looking budget it cannot date", () => {
    expect(quickSyncVerdict({ count: 4 }, budget, now)).toEqual({ affordable: false, retryAfterMs: 300_000 });
  });
});

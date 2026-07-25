import { describe, it, expect } from "vitest";
import {
  judgeProfile,
  openProfileNames,
  parseObservation,
  PROBE_FIELDS,
  probeProfileSync,
  probeScript,
  processNameFor,
  type ProfileObservation,
} from "../../src/profile-detect.js";
import { DEFAULT_EXE } from "../../src/config.js";

const STALE = "D:\\dev\\projects\\oml\\mlo-mcp\\profile\\profile.ml";
const REAL = "D:\\accounts\\mylifeorganized\\2022.ml";

/** The registry value exists on disk and MLO is closed — the uncontradicted case. */
function observation(over: Partial<ProfileObservation> = {}): ProfileObservation {
  return { lastDbFile: STALE, lastDbFileExists: true, appRunning: false, windowTitles: [], ...over };
}

/** Fails the test if the verdict refused; returns the accepted path. */
function accepted(s: ProfileObservation): string {
  const verdict = judgeProfile(s);
  if (!verdict.ok) throw new Error(`expected acceptance, got: ${verdict.message}`);
  return verdict.dataFile;
}

/** Fails the test if the verdict accepted; returns the refusal. */
function refused(s: ProfileObservation): { reason: string; message: string } {
  const verdict = judgeProfile(s);
  if (verdict.ok) throw new Error(`expected refusal, got: ${verdict.dataFile}`);
  return verdict;
}

describe("openProfileNames", () => {
  it("reads the open profile's file name off MLO's own window title", () => {
    expect(openProfileNames(["2022.ml - MyLifeOrganized"])).toEqual(["2022.ml"]);
  });

  it("ignores windows that name no profile (tray, dialogs, empty titles)", () => {
    expect(openProfileNames(["", "Task Add", "MyLifeOrganized"])).toEqual([]);
  });

  it("keeps a file name that itself contains the title separator", () => {
    // Greedy match to the LAST separator, or "my - tasks.ml" truncates to "tasks.ml"
    // and a legitimately open profile reads as a mismatch.
    expect(openProfileNames(["my - tasks.ml - MyLifeOrganized"])).toEqual(["my - tasks.ml"]);
  });

  it("strips an unsaved-changes marker", () => {
    expect(openProfileNames(["*2022.ml - MyLifeOrganized"])).toEqual(["2022.ml"]);
  });

  it("reduces a titled full path to its file name", () => {
    expect(openProfileNames(["D:\\accounts\\mylifeorganized\\2022.ml - MyLifeOrganized"])).toEqual(["2022.ml"]);
  });

  it("collects every profile-naming window and drops the rest", () => {
    expect(openProfileNames(["2022.ml - MyLifeOrganized", "Reminders", "work.ml - MyLifeOrganized"])).toEqual([
      "2022.ml",
      "work.ml",
    ]);
  });
});

describe("judgeProfile", () => {
  it("accepts the registry value when MLO is not running", () => {
    // Nothing can contradict it: no open profile exists to disagree with.
    expect(accepted(observation())).toBe(STALE);
  });

  it("accepts it when the running MLO has that very file open", () => {
    expect(
      accepted(observation({ appRunning: true, windowTitles: ["profile.ml - MyLifeOrganized"], lastDbFileHeldByOther: true }))
    ).toBe(STALE);
  });

  it("compares file names case-insensitively", () => {
    expect(
      accepted(observation({ appRunning: true, windowTitles: ["PROFILE.ML - MyLifeOrganized"], lastDbFileHeldByOther: true }))
    ).toBe(STALE);
  });

  it("refuses when the running MLO has a different profile open", () => {
    // The bug this exists for: MLO writes LastDBFile at exit, so an in-session
    // switch leaves the registry naming a profile the app no longer has open.
    const { reason, message } = refused(
      observation({ appRunning: true, windowTitles: ["2022.ml - MyLifeOrganized"], lastDbFileHeldByOther: false })
    );
    expect(reason).toBe("profile-switched");
    expect(message).toContain(STALE); // the stale value, so the user sees what was wrong
    expect(message).toContain("2022.ml"); // and what MLO actually has open
  });

  it("refuses a same-named profile in another directory", () => {
    // Title alone cannot tell D:\a\2022.ml from D:\b\2022.ml; the lock does.
    const { reason } = refused(
      observation({
        lastDbFile: "D:\\backup\\2022.ml",
        appRunning: true,
        windowTitles: ["2022.ml - MyLifeOrganized"],
        lastDbFileHeldByOther: false,
      })
    );
    expect(reason).toBe("profile-switched");
  });

  it("accepts on the lock alone when MLO sits in the tray with no window title", () => {
    expect(accepted(observation({ appRunning: true, windowTitles: [], lastDbFileHeldByOther: true }))).toBe(STALE);
  });

  it("refuses when MLO runs holding some other file, even unnamed", () => {
    const { reason, message } = refused(observation({ appRunning: true, windowTitles: [], lastDbFileHeldByOther: false }));
    expect(reason).toBe("profile-switched");
    expect(message).toContain(STALE);
  });

  it("accepts when neither signal is available rather than blocking on an unavailable one", () => {
    expect(accepted(observation({ appRunning: true, windowTitles: [], lastDbFileHeldByOther: undefined }))).toBe(STALE);
  });

  it("refuses when MLO recorded no profile at all", () => {
    const { reason, message } = refused(observation({ lastDbFile: undefined, lastDbFileExists: false }));
    expect(reason).toBe("no-profile");
    expect(message).toMatch(/open .*profile/i);
  });

  it("names the vanished path when the recorded profile no longer exists", () => {
    const { reason, message } = refused(observation({ lastDbFileExists: false }));
    expect(reason).toBe("no-profile");
    expect(message).toContain(STALE);
  });

  it("refuses when the probe itself failed", () => {
    const verdict = judgeProfile(undefined);
    expect(verdict.ok).toBe(false);
  });
});

describe("parseObservation", () => {
  const full = {
    lastDbFile: REAL,
    lastDbFileExists: true,
    appRunning: true,
    windowTitles: ["2022.ml - MyLifeOrganized"],
    lastDbFileHeldByOther: true,
  };

  it("parses the probe's JSON object", () => {
    expect(parseObservation(JSON.stringify(full))).toEqual(full);
  });

  it("tolerates a UTF-8 BOM ahead of the JSON", () => {
    expect(parseObservation(`\uFEFF${JSON.stringify(full)}`)?.lastDbFile).toBe(REAL);
  });

  it("re-wraps the lone title PowerShell collapses into a bare string", () => {
    // ConvertTo-Json emits a one-element array as a scalar.
    expect(parseObservation(JSON.stringify({ ...full, windowTitles: "2022.ml - MyLifeOrganized" }))?.windowTitles).toEqual([
      "2022.ml - MyLifeOrganized",
    ]);
  });

  it("reads an absent title list as no titles", () => {
    expect(parseObservation(JSON.stringify({ ...full, windowTitles: null }))?.windowTitles).toEqual([]);
  });

  it("treats a blank recorded path as none, not as an empty-string path", () => {
    expect(parseObservation(JSON.stringify({ ...full, lastDbFile: "   " }))?.lastDbFile).toBeUndefined();
  });

  it("keeps an unavailable lock result distinct from a negative one", () => {
    expect(parseObservation(JSON.stringify({ ...full, lastDbFileHeldByOther: null }))?.lastDbFileHeldByOther).toBeUndefined();
  });

  it("reports non-JSON output as a failed probe", () => {
    expect(parseObservation("Get-Process : cannot find process")).toBeUndefined();
    expect(parseObservation("")).toBeUndefined();
  });

  it("rejects the object outright when a contracted key is missing", () => {
    // The probe script and this parser drifting apart must not read as "signal
    // unavailable" — that is the permissive direction, and it would disarm
    // detection silently. Every key is emitted even when null, so an absent one
    // is drift, and drift fails the parse.
    for (const dropped of Object.keys(full)) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[dropped];
      expect(parseObservation(JSON.stringify(partial)), `dropping ${dropped}`).toBeUndefined();
    }
  });

  it("keeps a null-valued key, which is not a missing one", () => {
    expect(parseObservation(JSON.stringify({ ...full, lastDbFile: null }))).toBeDefined();
  });
});

/**
 * The one seam the pure tests cannot reach: the hand-written PowerShell has to
 * keep emitting the JSON `parseObservation` reads. A renamed field or a broken
 * try/catch would otherwise degrade silently into "no signal available", which
 * is the permissive direction — detection would stop refuting anything.
 * Read-only, and needs no mlo.exe: it queries the registry, the process list,
 * and opens the recorded profile for reading.
 */
describe.skipIf(process.platform !== "win32")("the PowerShell probe's contract", () => {
  const probed = probeProfileSync(DEFAULT_EXE);

  it("returns a parseable observation", () => {
    expect(probed).toBeDefined();
  });

  it("fills every field with the type judgeProfile expects", () => {
    expect(typeof probed!.lastDbFileExists).toBe("boolean");
    expect(typeof probed!.appRunning).toBe("boolean");
    expect(Array.isArray(probed!.windowTitles)).toBe(true);
    expect(probed!.windowTitles.every((t) => typeof t === "string")).toBe(true);
    expect(probed!.lastDbFile === undefined || typeof probed!.lastDbFile === "string").toBe(true);
  });

  it("actually runs the exclusive-open test whenever there is a file to test", () => {
    // The refuting signal. A boolean here proves the open was attempted and
    // its outcome captured, rather than swallowed into null.
    if (probed!.lastDbFile && probed!.lastDbFileExists) {
      expect(typeof probed!.lastDbFileHeldByOther).toBe("boolean");
    } else {
      expect(probed!.lastDbFileHeldByOther).toBeUndefined();
    }
  });

  it("finds mlo.exe by a process name derived from the configured exe path", () => {
    expect(processNameFor(DEFAULT_EXE)).toBe("mlo");
    expect(processNameFor("D:\\custom\\MLO Portable\\mlo.exe")).toBe("mlo");
  });
});

describe("processNameFor", () => {
  it("strips the extension whatever its casing", () => {
    // Windows reports process names without the extension, so a surviving
    // ".EXE" matches nothing — which reads as "MLO is not running" and accepts
    // the registry candidate unchecked. A capitalised MLO_EXE_PATH would have
    // silently restored the bug this module exists to prevent.
    expect(processNameFor("C:\\MLO\\MLO.EXE")).toBe("MLO");
    expect(processNameFor("C:\\MLO\\Mlo.Exe")).toBe("Mlo");
  });

  it("matches the process case-insensitively, so casing never decides", () => {
    // Belt to that brace: the probe compares with -ieq. Asserted here because
    // the comparison lives in a PowerShell string no type checker reads.
    expect(probeScript("MLO")).toContain("-ieq");
  });
});

describe("probeScript", () => {
  it("emits every key parseObservation requires", () => {
    // The other half of the strict parse: assert the contract in the script
    // text, so renaming a field on one side alone fails here rather than
    // degrading a working install into a refusal at startup.
    for (const field of PROBE_FIELDS) {
      expect(probeScript("mlo"), `missing ${field}`).toContain(`${field}=`);
    }
  });

  it("doubles a quote in the process name so it cannot end the string", () => {
    // The only interpolated value in the script. Derived from a path, so an
    // apostrophe in a portable install's folder is enough to reach it.
    expect(probeScript("m'lo")).toContain("'m''lo'");
  });
});

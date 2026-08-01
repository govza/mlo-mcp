import { describe, it, expect } from "vitest";
import {
  judgeProfile,
  openProfileNames,
  parseLogEvents,
  parseObservation,
  PROBE_FIELDS,
  probeProfileSync,
  probeScript,
  processNameFor,
  resolveRun,
  type ProfileObservation,
} from "../../src/profile-detect.js";
import { DEFAULT_EXE } from "../../src/config.js";

const REAL = "D:\\dev\\demo\\demo.ml";
const OTHER = "D:\\accounts\\mylifeorganized\\2022.ml";
const PID = 8744;

/** A line exactly as MLO writes it: date, zero-padded pid, time, message. */
function line(pid: number, message: string): string {
  return `01/08/2026 [${String(pid).padStart(6, "0")}] 15:38:27.593      ${message}`;
}

const STARTED = "--- Log started Ver. 6.1.3";

/** One MLO running, its session block naming REAL, and REAL held open. */
function observation(over: Partial<ProfileObservation> = {}): ProfileObservation {
  return {
    apps: [{ pid: PID, windowTitle: "demo.ml - MyLifeOrganized" }],
    logRead: true,
    lines: [line(PID, STARTED), line(PID, `Opening datafile: ${REAL}`)],
    held: { [REAL]: "held" },
    ...over,
  };
}

/** Fails the test if the verdict refused; returns the accepted path. */
function accepted(observed: ProfileObservation): string {
  const verdict = judgeProfile(observed);
  if (!verdict.ok) throw new Error(`expected acceptance, got: ${verdict.message}`);
  return verdict.dataFile;
}

/** Fails the test if the verdict accepted; returns the refusal. */
function refused(observed: ProfileObservation): { reason: string; message: string } {
  const verdict = judgeProfile(observed);
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

  it("collects every profile-naming window and drops the rest", () => {
    expect(openProfileNames(["2022.ml - MyLifeOrganized", "Reminders", "work.ml - MyLifeOrganized"])).toEqual([
      "2022.ml",
      "work.ml",
    ]);
  });
});

describe("parseLogEvents", () => {
  it("reads the pid off the line, leading zeros and all", () => {
    expect(parseLogEvents([line(42, STARTED)])).toEqual([{ pid: 42, kind: "started" }]);
  });

  it("takes an opened profile from either verb MLO uses", () => {
    // "Save as" is not a copy: it switches the run to the new file, which is
    // what the title bar then shows.
    expect(parseLogEvents([line(PID, `Opening datafile: ${REAL}`), line(PID, `Save as: ${OTHER}`)])).toEqual([
      { pid: PID, kind: "opened", file: REAL },
      { pid: PID, kind: "opened", file: OTHER },
    ]);
  });

  it("records a never-saved outline as its own kind, carrying no file", () => {
    expect(parseLogEvents([line(PID, "New data file created")])).toEqual([{ pid: PID, kind: "unsaved" }]);
  });

  it("ignores everything else MLO logs", () => {
    expect(
      parseLogEvents([
        line(PID, "[dpi] Monitor #0 (3840x2160) dpi=216"),
        line(PID, "TExMLOSync : Unable to load WSDL File/Location: https://sync.mylifeorganized.net/"),
        line(PID, "Requesting temp file in folder: \"C:\\Users\\Go\\AppData\\Local\\Temp\""),
        "",
        "not a log line at all",
      ])
    ).toEqual([]);
  });

  it("keeps a path containing spaces whole and trims the trailing padding", () => {
    expect(parseLogEvents([line(PID, "Opening datafile: D:\\my tasks\\work profile.ml   ")])[0]!.file).toBe(
      "D:\\my tasks\\work profile.ml"
    );
  });
});

describe("resolveRun", () => {
  const events = (...messages: string[]) => parseLogEvents(messages.map((m) => line(PID, m)));

  it("takes the profile the run's session block names", () => {
    expect(resolveRun(PID, events(STARTED, `Opening datafile: ${REAL}`))).toEqual({ kind: "profile", dataFile: REAL });
  });

  it("follows an in-app switch, because MLO logs every open it makes", () => {
    // The whole point of asking the process: the answer moves with the app
    // instead of describing the session that has ended.
    expect(resolveRun(PID, events(STARTED, `Opening datafile: ${REAL}`, `Opening datafile: ${OTHER}`))).toEqual({
      kind: "profile",
      dataFile: OTHER,
    });
  });

  it("reports a run holding a never-saved outline as having no data file", () => {
    expect(resolveRun(PID, events(STARTED, `Opening datafile: ${REAL}`, "New data file created"))).toEqual({
      kind: "unsaved",
    });
  });

  it("takes the path a new outline was then saved to", () => {
    // The live case: MLO 6 on a fresh profile, whose only path event is the Save As.
    expect(resolveRun(PID, events(STARTED, "New data file created", `Save as: ${REAL}`))).toEqual({
      kind: "profile",
      dataFile: REAL,
    });
  });

  it("ignores an earlier run that happened to carry the same pid", () => {
    // Windows recycles pids, so a block from days ago could name a profile that
    // has nothing to do with the live process. Only the LAST block speaks.
    expect(resolveRun(PID, events(STARTED, `Opening datafile: ${OTHER}`, STARTED, `Opening datafile: ${REAL}`))).toEqual(
      { kind: "profile", dataFile: REAL }
    );
  });

  it("knows nothing about a run with no session block, rather than borrowing another's", () => {
    const other = parseLogEvents([line(999, STARTED), line(999, `Opening datafile: ${OTHER}`)]);
    expect(resolveRun(PID, other)).toEqual({ kind: "unknown" });
  });

  it("knows nothing about a run that has opened nothing yet", () => {
    // MLO's single-instance handoff: a second launch logs a block, forwards, exits.
    expect(resolveRun(PID, events(STARTED))).toEqual({ kind: "unknown" });
  });
});

describe("judgeProfile", () => {
  it("accepts the profile the running process says it opened", () => {
    expect(accepted(observation())).toBe(REAL);
  });

  it("accepts a profile whose only path event is a Save As", () => {
    // Reproduces the install that could not start: LastDBFile was empty, and the
    // open profile existed only in the running app's own record of it.
    expect(
      accepted(
        observation({
          lines: [line(PID, STARTED), line(PID, "New data file created"), line(PID, `Save as: ${REAL}`)],
        })
      )
    ).toBe(REAL);
  });

  it("refuses when MLO is not running, because nothing else may answer for it", () => {
    const { reason, message } = refused(observation({ apps: [] }));
    expect(reason).toBe("profile-not-open");
    expect(message).toMatch(/not running/i);
  });

  it("refuses when the running app has only an unsaved outline open", () => {
    const { reason, message } = refused(
      observation({ lines: [line(PID, STARTED), line(PID, "New data file created")], held: {} })
    );
    expect(reason).toBe("profile-not-open");
    expect(message).toMatch(/save it/i);
  });

  it("accepts on the log and the lock alone while MLO sits in the tray", () => {
    // The title is empty for most of a session on MLO's minimize-to-tray defaults,
    // so it must never be required.
    expect(accepted(observation({ apps: [{ pid: PID, windowTitle: "" }] }))).toBe(REAL);
  });

  it("refuses when the window title names a different profile than the log", () => {
    const { reason, message } = refused(
      observation({ apps: [{ pid: PID, windowTitle: "2022.ml - MyLifeOrganized" }] })
    );
    expect(reason).toBe("profile-contradicted");
    expect(message).toContain(REAL);
    expect(message).toContain("2022.ml");
  });

  it("compares the title's file name case-insensitively", () => {
    expect(accepted(observation({ apps: [{ pid: PID, windowTitle: "DEMO.ML - MyLifeOrganized" }] }))).toBe(REAL);
  });

  it("refuses when nothing holds the named file open", () => {
    // MLO holds its open profile for the whole session, so a free file is one it
    // does not have open — the signal that catches a same-named profile elsewhere.
    const { reason, message } = refused(observation({ held: { [REAL]: "free" } }));
    expect(reason).toBe("profile-contradicted");
    expect(message).toContain(REAL);
  });

  it("refuses when the named file is gone from disk", () => {
    const { reason } = refused(observation({ held: { [REAL]: "missing" } }));
    expect(reason).toBe("profile-contradicted");
  });

  it("matches the lock result to the path case-insensitively", () => {
    // The log and the probe spell the same path independently.
    expect(accepted(observation({ held: { "d:\\DEV\\demo\\DEMO.ML": "held" } }))).toBe(REAL);
  });

  it("accepts a path the probe never tested rather than blocking on it", () => {
    expect(accepted(observation({ held: {} }))).toBe(REAL);
  });

  it("accepts when two instances have the same profile open", () => {
    expect(
      accepted(
        observation({
          apps: [
            { pid: PID, windowTitle: "demo.ml - MyLifeOrganized" },
            { pid: 4242, windowTitle: "demo.ml - MyLifeOrganized" },
          ],
          lines: [
            line(PID, STARTED),
            line(PID, `Opening datafile: ${REAL}`),
            line(4242, STARTED),
            line(4242, `Opening datafile: ${REAL}`),
          ],
        })
      )
    ).toBe(REAL);
  });

  it("refuses when two instances have different profiles open", () => {
    const { reason, message } = refused(
      observation({
        apps: [
          { pid: PID, windowTitle: "" },
          { pid: 4242, windowTitle: "" },
        ],
        lines: [
          line(PID, STARTED),
          line(PID, `Opening datafile: ${REAL}`),
          line(4242, STARTED),
          line(4242, `Opening datafile: ${OTHER}`),
        ],
        held: { [REAL]: "held", [OTHER]: "held" },
      })
    );
    expect(reason).toBe("profile-contradicted");
    expect(message).toContain(REAL);
    expect(message).toContain(OTHER);
  });

  it("ignores an instance that has opened nothing beside one that has", () => {
    // The handoff process exists for a second or two and must not make the
    // answer ambiguous.
    expect(
      accepted(
        observation({
          apps: [
            { pid: PID, windowTitle: "demo.ml - MyLifeOrganized" },
            { pid: 4242, windowTitle: "" },
          ],
          lines: [line(PID, STARTED), line(PID, `Opening datafile: ${REAL}`), line(4242, STARTED)],
        })
      )
    ).toBe(REAL);
  });

  describe("what it will not cycle a live session over", () => {
    // index.ts exits the session on every refusal EXCEPT "undetectable". These
    // three are the cases where the answer is unknown rather than negative, so
    // classifying one of them as definite would restart a working server on a
    // transient fault.
    it("cannot tell when the probe itself failed", () => {
      const verdict = judgeProfile(undefined);
      expect(verdict.ok === false && verdict.reason).toBe("profile-undetectable");
    });

    it("cannot tell when MLO's log could not be read", () => {
      const { reason, message } = refused(observation({ logRead: false, lines: [] }));
      expect(reason).toBe("profile-undetectable");
      expect(message).toMatch(/logging/i);
    });

    it("cannot tell when the log carries no session for the running app", () => {
      // A log that rotated mid-session, which is recoverable by reopening the
      // profile — not a statement that the profile is gone.
      const { reason, message } = refused(observation({ lines: [], held: {} }));
      expect(reason).toBe("profile-undetectable");
      expect(message).toMatch(/rotated/i);
    });
  });
});

describe("parseObservation", () => {
  const full = {
    apps: [{ pid: PID, windowTitle: "demo.ml - MyLifeOrganized" }],
    logRead: true,
    lines: [line(PID, STARTED)],
    held: { [REAL]: "held" },
  };

  it("parses the probe's JSON object", () => {
    expect(parseObservation(JSON.stringify(full))).toEqual(full);
  });

  it("tolerates a UTF-8 BOM ahead of the JSON", () => {
    expect(parseObservation(`\uFEFF${JSON.stringify(full)}`)?.apps).toEqual(full.apps);
  });

  it("re-wraps the lone element PowerShell collapses into a bare scalar", () => {
    // ConvertTo-Json emits a one-element array as its element.
    const collapsed = { ...full, apps: full.apps[0], lines: full.lines[0] };
    expect(parseObservation(JSON.stringify(collapsed))).toEqual(full);
  });

  it("reads an empty result as no apps and no lines", () => {
    const empty = parseObservation(JSON.stringify({ ...full, apps: null, lines: null }));
    expect(empty?.apps).toEqual([]);
    expect(empty?.lines).toEqual([]);
  });

  it("drops an app entry with no usable pid rather than inventing one", () => {
    expect(parseObservation(JSON.stringify({ ...full, apps: [{ windowTitle: "x" }] }))?.apps).toEqual([]);
  });

  it("reads a null window title as the tray case", () => {
    expect(parseObservation(JSON.stringify({ ...full, apps: [{ pid: 1, windowTitle: null }] }))?.apps).toEqual([
      { pid: 1, windowTitle: "" },
    ]);
  });

  it("drops a lock result that is not one of the three states", () => {
    // An unrecognised value must read as "not tested" (which never refutes),
    // never as a state judgeProfile would act on.
    expect(parseObservation(JSON.stringify({ ...full, held: { [REAL]: "maybe" } }))?.held).toEqual({});
  });

  it("reports non-JSON output as a failed probe", () => {
    expect(parseObservation("Get-Process : cannot find process")).toBeUndefined();
    expect(parseObservation("")).toBeUndefined();
  });

  it("rejects the object outright when a contracted key is missing", () => {
    // The probe script and this parser drifting apart must not read as "signal
    // unavailable" — that is the permissive direction, and it would disarm
    // detection silently. Every key is emitted even when empty, so an absent one
    // is drift, and drift fails the parse.
    for (const dropped of Object.keys(full)) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[dropped];
      expect(parseObservation(JSON.stringify(partial)), `dropping ${dropped}`).toBeUndefined();
    }
  });
});

describe("probeScript", () => {
  it("emits every key parseObservation requires", () => {
    // The other half of the strict parse: assert the contract in the script
    // text, so renaming a field on one side alone fails here rather than
    // degrading a working install into a refusal at startup.
    for (const field of PROBE_FIELDS) {
      expect(probeScript(DEFAULT_EXE), `missing ${field}`).toContain(`${field}=`);
    }
  });

  it("keeps every log verb the parser reads", () => {
    // The script filters the log down to these lines and parseLogEvents reads
    // them. A verb dropped on the script side would silently starve detection.
    for (const verb of ["--- Log started", "Opening datafile:", "Save as:", "New data file created"]) {
      expect(probeScript(DEFAULT_EXE), `missing ${verb}`).toContain(verb);
    }
  });

  it("looks for MLO's log beside a portable install as well as under LOCALAPPDATA", () => {
    expect(probeScript("D:\\MLO Portable\\mlo.exe")).toContain("D:\\MLO Portable\\Logs\\mlo_log.txt");
    expect(probeScript(DEFAULT_EXE)).toContain("$env:LOCALAPPDATA");
  });

  it("doubles a quote in either value it interpolates, so neither can end the string", () => {
    // Both derive from the exe path, so an apostrophe in a portable install's
    // folder is enough to reach them.
    const script = probeScript("D:\\Ann's Tools\\m'lo.exe");
    expect(script).toContain("'m''lo'");
    expect(script).toContain("D:\\Ann''s Tools\\Logs\\mlo_log.txt");
  });
});

describe("processNameFor", () => {
  it("strips the extension whatever its casing", () => {
    // Windows reports process names without the extension, so a surviving
    // ".EXE" matches nothing — which reads as "MLO is not running" and refuses
    // to start on a machine that has a profile open.
    expect(processNameFor("C:\\MLO\\MLO.EXE")).toBe("MLO");
    expect(processNameFor("C:\\MLO\\Mlo.Exe")).toBe("Mlo");
  });

  it("matches the process case-insensitively, so casing never decides", () => {
    // Belt to that brace: the probe compares with -ieq. Asserted here because
    // the comparison lives in a PowerShell string no type checker reads.
    expect(probeScript(DEFAULT_EXE)).toContain("-ieq");
  });
});

/**
 * The one seam the pure tests cannot reach: the hand-written PowerShell has to
 * keep emitting the JSON `parseObservation` reads, and the lines it selects out
 * of MLO's log have to be lines `parseLogEvents` understands. Drift on either
 * side would degrade silently into "no signal available", which is the
 * permissive direction. Read-only, and needs no mlo.exe: it lists processes,
 * reads MLO's log, and opens the profiles that log names for reading.
 */
describe.skipIf(process.platform !== "win32")("the PowerShell probe's contract", () => {
  const probed = probeProfileSync(DEFAULT_EXE);

  it("returns a parseable observation", () => {
    expect(probed).toBeDefined();
  });

  it("fills every field with the type judgeProfile expects", () => {
    expect(Array.isArray(probed!.apps)).toBe(true);
    expect(probed!.apps.every((app) => Number.isInteger(app.pid) && typeof app.windowTitle === "string")).toBe(true);
    expect(typeof probed!.logRead).toBe("boolean");
    expect(probed!.lines.every((l) => typeof l === "string")).toBe(true);
    expect(Object.values(probed!.held).every((state) => ["held", "free", "missing"].includes(state))).toBe(true);
  });

  it("selects only lines the parser can read", () => {
    // Vacuous when MLO is closed, which is the state the rest of the suite runs
    // in; it earns its keep on a developer machine with the GUI open.
    expect(parseLogEvents(probed!.lines)).toHaveLength(probed!.lines.length);
  });

  it("lock-tests every profile those lines name", () => {
    const named = new Set(parseLogEvents(probed!.lines).flatMap((event) => (event.file ? [event.file] : [])));
    const tested = new Set(Object.keys(probed!.held).map((file) => file.toLowerCase()));
    for (const file of named) expect(tested, `untested: ${file}`).toContain(file.toLowerCase());
  });
});

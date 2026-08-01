# ADR-0006: Detect the open profile from the running process alone

Status: accepted (2026-08-01), implemented (2026-08-01). Supersedes
[ADR-0004](0004-ground-truth-the-open-profile.md).

## Context

[ADR-0004](0004-ground-truth-the-open-profile.md) made the registry's
`LastDBFile` a *candidate* and checked it against the running app, because MLO
writes that value when it **exits** and it goes stale after an in-app profile
switch. That fixed the silent wrong-profile read. It did not fix the source.

A default install could not start at all. Observed live: `mlo.exe` running,
`demo.ml - MyLifeOrganized` in the title bar, `D:\dev\demo\demo.ml` held open —
and `LastDBFile` an **empty string**, so detection refused with "MLO's settings
record no last-opened profile. Open your profile in MLO once so the server can
detect it." The profile *was* open. The advice was unfollowable.

Empty is not exotic. `LastDBFile` is written on a clean exit, and MLO's shipped
defaults (`ShowInTray`, `MinimizeToTray`, `CloseToTray` all on) mean closing the
window does not exit the app; the same install recorded 532 unexpected quits.
An install that has never exited cleanly has never written the value.

The structural problem is that ADR-0004's two signals *refute* but cannot
*discover*: the window title carries no directory, and the exclusive-open test
needs a path to test. With no candidate there is nothing to refute, so the
refusal is unconditional however much the running app is willing to say.

ADR-0004 also recorded that there is "no MLO-maintained recent-profiles list on
disk to search". That is wrong — `HKCU\Software\MyLifeOrganized.net\MyLife\Settings\MRU`
holds `F0`..`F5`. It would not have helped: on the same machine `F0` named a file
that no longer existed and the open profile was absent from the list entirely.
Recorded here so the option is not re-investigated.

What the running app *does* say, in its own log, is the whole answer. MLO writes
one session block per run, tagged with that run's pid, and records every profile
that run opens:

```text
01/08/2026 [008744] 15:24:18.468      --- Log started Ver. 6.1.3
01/08/2026 [008744] 15:38:13.654      New data file created
01/08/2026 [008744] 15:38:27.593      Save as: D:\dev\demo\demo.ml
```

`[008744]` is the pid of the running `mlo.exe`. That is a live process
describing its own state, not a note left for next time.

## Decision

**Only the running process is asked. Nothing MLO saved for next time is read** —
not `LastDBFile`, not the MRU. A saved value describes a session that has ended,
and there is no reading of one that is safe: trusted it serves the wrong tree,
checked it adds nothing the process was not already saying, and used as a
fallback it fails exactly when the process cannot be asked, which is when it is
least checkable.

Detection is therefore: find every running `mlo.exe`, read each one's own
session block out of MLO's log, and take the profile it last says it opened.
Three verbs carry the state, and the last one in the block wins:

- `Opening datafile: <path>` and `Save as: <path>` both leave that file as the
  run's open profile — "Save as" switches MLO to the new file rather than
  copying it, which is what the title bar then shows.
- `New data file created` leaves the run with an outline that has no file, so it
  *clears* a previously opened path instead of being ignored.

Scoping to the run's **last** session block is what makes this the process's
statement rather than a leftover: Windows recycles pids, so an older block
carrying the same number could name an unrelated profile. An in-app switch
appends a new `Opening datafile` to the live block, which is how the answer
follows the app instead of going stale — the fault ADR-0004 could only detect is
now structurally absent, because there is no saved value left to disagree with.

**ADR-0004's two signals are kept, demoted to corroboration**, each used only for
what it can prove and never able to manufacture an answer:

- the **window title** must name the same file when a window exists (it is empty
  while MLO sits in the tray, so it can never be required);
- the resolved file must be **held open** by another process, since MLO holds its
  open profile all session — this is what distinguishes same-named profiles in
  different directories.

An *unavailable* signal never refutes. A *contradicting* one refuses rather than
substituting a guess, exactly as before.

**Refusals are classified by what a live session must do about them**, not by
cause, because the 60s watcher acts on them:

| reason | meaning | watcher |
|---|---|---|
| `no-open-profile` | MLO is not running, or has only a never-saved outline open | exit |
| `contradicted` | the app's own signals disagree, or two instances hold different profiles | exit |
| `undetectable` | we could not tell — probe failed, log unreadable, log rotated past the run's block | stay up |

The split is the load-bearing part: a definite negative means the session is
serving a profile nothing has open and must respawn into a fresh detection,
while "cannot tell" is transient and must never cycle a working server.

**Collection and policy stay separated.** One PowerShell round trip gathers
processes, their titles, their own lines out of the log, and the lock test on
every profile those lines name; `judgeProfile` is a pure function over that
observation, so every combination is unit-testable with no registry, process
list, log, or MLO. The script reads a path itself only to know what to
lock-test, and a path its cruder regex misses comes back untested — which never
refutes.

## Options not taken

- **Enumerating the process's open file handles** (`NtQuerySystemInformation` +
  `NtQueryObject`). The only signal needing no cooperation from MLO at all, and
  the one ADR-0004 already declined. It means P/Invoke compiled at runtime by
  `Add-Type` — seconds per probe, and this runs every 60s — plus the standard
  hang on synchronous handle types. MLO's log gives the same answer for the
  price of a text read.
- **Keeping `LastDBFile` as a fallback for when MLO is closed.** This is exactly
  "the last saved place", reintroduced on the one path where nothing can check
  it. A fallback that is only ever used unverified is not a fallback.
- **The `MRU` list.** Same class of stale, and observed stale on the machine that
  motivated this record.
- **Parsing the log's timestamps** to bind a block to a process start time.
  MLO writes them in the locale's date order (`01/08/2026` here), so the parse
  would be ambiguous exactly where it needs to be exact. Requiring the last
  session block plus the two corroborating signals covers pid reuse without it.
- **A `MLO_DATA_FILE` override.** Unchanged from ADR-0004: the app's open profile
  is the only one the server can operate on, so an override just re-creates the
  fault as a configuration option. `--data-file=` stays internal to the test
  harness, which runs `mlo.exe` on temp copies with the GUI closed.

## Consequences

- **MLO must be running for the server to start**, and a session exits when MLO
  stops running. This is the real cost, and it is the honest reading of
  "the app's open profile is the only profile": with no app there is no open
  profile, and inventing one is the fault this line of decisions exists to
  prevent. MLO's tray defaults mean it is running whenever the user is using it.
- Detection depends on MLO's logging, which is on by default. Turned off, every
  answer is `undetectable` — a refusal that names the setting, and one that never
  cycles a live session.
- MLO rotates the log at ~30 MB. A rotation mid-session cuts the running block,
  which reads as `undetectable` with "reopen the profile" as the remedy; the
  probe reads the last 4 MB, which spans many runs on a normal install.
- Still one PowerShell process at startup and one per 60s tick, as ADR-0004 left
  it; the round trip now also reads the log tail and returns the selected lines.
- The probe's JSON shape stays pinned by a Windows-gated contract test, now with
  a second obligation: the lines the script selects must be lines the parser
  understands, since drift there would starve detection silently.

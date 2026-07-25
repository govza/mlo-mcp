# ADR-0004: Ground-truth the open profile against the running app, and refuse when it disagrees

Status: accepted (2026-07-25), implemented (2026-07-25)

## Context

There is no profile setting: the server operates on whatever profile MLO itself
has open, because that is the only profile it can fully operate on — reads drive
`mlo.exe`, and writes ride that profile's sync. Detection read one registry
value, `HKCU\Software\MyLifeOrganized.net\MyLife\Settings\LastDBFile`, and
trusted it. The README stated MLO "updates [it] whenever it opens a profile".

It does not. **MLO writes `LastDBFile` when it exits**, not when it opens a
profile. After an in-app profile switch the value names a profile the app no
longer has open, and it stays wrong for the rest of the session.

Observed live: `mlo.exe` had been launched with no argument at 15:06 and had
`2022.ml - MyLifeOrganized` in its title bar, while `LastDBFile` still read
`D:\dev\projects\oml\mlo-mcp\profile\profile.ml` — the repo's dev profile, last
written at 11:24. The server started against the dev profile, exported it
successfully, and answered "read the inbox" from the wrong tree: the sample
`.Introduction` outline and an empty `<Inbox>`. Nothing failed. `existsSync`
passed, the export passed, and every tool reported success.

Two mechanisms made it worse than a one-off:

- The 60s switch watcher polled **the same stale value**, so the documented
  "follows profile switches" behavior could not fire — the one safeguard aimed at
  exactly this fault was blind to it.
- Restarting the server did not help. It re-detected the same wrong path, so the
  natural remedy confirmed the wrong answer.

Silently reading the wrong profile is bad; silently *writing* to it is worse.
A write rides the open profile's sync, so a stale detection would queue deltas
against a profile the user is not using.

## Decision

**The registry value is a candidate, not an answer.** It is checked against the
running app, which is the only authority on what it has open. Two signals can
refute it; neither can be manufactured from the registry:

- **The main window title.** MLO titles its window `<name>.ml - MyLifeOrganized`,
  naming the open profile. It gives only a file name, and only while a window
  exists — it is empty while MLO sits in the tray, which was true within minutes
  of the first observation.
- **The exclusive open.** MLO holds the open profile's file for the whole
  session, so a file nobody else holds is a file MLO does not have open. This is
  the signal that distinguishes same-named profiles in different directories,
  which the title cannot, and it is the one that caught the live case once the
  title went empty.

Each signal is used only for what it can prove. A refutation from either is
enough; an *unavailable* signal never refutes. So a missing title or an
untestable file leaves the candidate standing: a server that cannot *check* a
candidate still starts on it.

That permissiveness is per-signal and stops there. A probe that fails
*altogether* yields no candidate to be permissive about, so it refuses — with a
message that names the probe rather than advising a fix in MLO, because nothing
the user does in MLO would change it.

**A refuted candidate is a refusal to start, not a substitution.** Neither
signal can discover an unrecorded path: the title carries no directory, and
there is no MLO-maintained recent-profiles list on disk to search (the shell's
`OpenSavePidlMRU` and Recent-items entries do not contain profiles opened from
MLO's own recent list — checked, and the live profile was absent from both).
Guessing a directory would risk operating on a *third* profile, so the server
names what it found and stops. The message states both paths and both remedies:
switch back in MLO, or close and reopen MLO so the exit write records the
profile actually in use.

**The watcher exits on a refusal too**, not only on a changed path. A refusal
means MLO no longer has our profile open, and a session that stayed up would
keep answering from it. The respawn re-runs detection, and the refusal reaches
the user as a startup failure with the reason on stderr — detection runs in
`loadConfig()`, before the transport is connected, so there is no MCP session to
return a protocol error on. Only `profile-switched` qualifies — a failed probe is
transient and must not cycle a working session. The probe also runs only while
no `mlo.exe` operation is in flight: it opens the data file denying all sharing,
which is the contention the data file's own lock exists to prevent.

**The policy is a pure function of one observation** (`judgeProfile`), so every
combination of signals is unit-testable without a registry, a process list, or
MLO. The impure part is one PowerShell round trip returning all of it as JSON;
its output shape is pinned by a Windows-gated contract test, because a renamed
field would otherwise degrade silently into "no signal available", which is the
permissive direction.

## Options not taken

- **Enumerating the process's open file handles** to read the path directly.
  This is the only approach that could *resolve* a switched-to profile instead
  of refusing, and it needs `NtQuerySystemInformation` or a Sysinternals
  `handle.exe` that is not installed — a native dependency and an
  admin-privilege question, to remove a refusal that correctly tells the user to
  do something in an app they already have open.
- **Trusting the window title alone.** It went empty within minutes of the
  observation that motivated this record. As the sole signal it would have made
  detection permissive again in the tray case — the common one, given MLO's
  minimize-to-tray defaults.
- **Trusting the exclusive open alone.** Sufficient today, but it cannot *name*
  the profile MLO has open, and a refusal that cannot say what is actually open
  is much harder to act on.
- **Searching the disk for the titled file name.** Slow on a startup path, and
  ambiguous exactly when it matters — several profiles legitimately share a
  name.
- **Keeping the old behavior and only logging the disagreement.** One stderr
  line nobody reads was already how this failed: the tools all reported success.
- **A `MLO_DATA_FILE`-style user override.** Deliberately removed earlier; the
  app's open profile is the only one the server can operate on, so an override
  just re-creates this bug as a configuration option. `--data-file=` stays
  internal to the test harness, which runs `mlo.exe` on temp copies with the GUI
  closed, and it bypasses these checks by design.

## Consequences

- The wrong-profile fault is now impossible to hit silently: either detection
  agrees with the running app, or the server refuses with both paths named.
- A false refusal becomes possible in principle — it needs MLO to release its
  handle on a profile it still has open, which was not observed. The direction
  is deliberate: a refusal that names the remedy is recoverable, silently
  serving the wrong tree is not.
- Detection costs one PowerShell process at startup and one per 60s tick, the
  same as before; the probe does more work in the same round trip.
- Startup now depends on the configured `mloExePath` (the process is found by
  its name), so `loadConfig` resolves the exe before the data file.
- `MLO_EXE_PATH` pointing at a differently-named executable stays supported: the
  process name is derived from it rather than hardcoded to `mlo`.

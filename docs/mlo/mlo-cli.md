# The mlo.exe command line

`mlo.exe` (default `C:\Program Files (x86)\MyLifeOrganized.net\MLO\mlo.exe`, 32-bit Delphi) has an undocumented but capable CLI. Everything below was verified empirically.

## Syntax

```
mlo.exe [<FileToOpen>] [-QuickSync] [-task={GUID}] [-AddSubtask="<Caption>"]
        [-Parse] [-saveXML="<File>"] [-saveML="<File>"] [-saveOPML="<File>"]
        [-zoom] [-url=<mlo-url>] [-nocloud] [-console] [-?]
```

**The verb list is closed.** The vendor's shipped help (`mlo.chm`) and the
binary's own IPC dispatcher (`ProcessMSG*`) enumerate every verb; there is no
update, complete, or delete verb - `-AddSubtask` is the only mutating one.
The extras beyond the original syntax line: `-zoom` (zoom the GUI to the
`-task` target), `-saveOPML` (OPML export, same never-overwrite rule as
`-saveXML`/`-saveML`), `-url` (open an `mlo:`-scheme link), `-nocloud`
(suppress cloud features for the launch); none of them mutate task data.

### Exit codes (ERRORLEVEL)

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | invalid command-line argument |
| 2 | target file already exists (`-saveXML`/`-saveML` **never overwrite** — pre-delete the target) |
| 3 | error writing target file |
| 100 | other error |

## Critical rules

1. **Always pass `-console`.** Without it mlo.exe stays resident as a GUI process and the invocation never "finishes".
2. **Delphi argument quoting.** A literal `"` inside a quoted argument must be doubled (`""`). The CommandLineToArgvW-style `\"` escaping that Node/.NET produce by default makes MLO misparse the whole command (it may pop a modal "task not found" Warning and hang). From Node: build the command line yourself with `windowsVerbatimArguments: true`, and quote the exe path itself via `argv0` — its spaces otherwise shift every parameter the child parses.
3. **Single instance + IPC.** If an MLO GUI is running, a second `mlo.exe` invocation forwards its command to the running instance (which autosaves after mutations). Exit code 0 still returned. Consequences:
   - `-AddSubtask` without `-task` is applied to **whatever row the user has selected** ("Add subtask to the selected task") — placement is nondeterministic while the GUI is open.
   - `-task={GUID}` **zooms the user's GUI** to that task, and the zoom persists — later exports return only the zoomed subtree.
   - An invalid `-task` GUID (e.g. the root's GUID) pops a modal Warning dialog in the GUI and the CLI process never exits.
   - **Always pass the explicit `<FileToOpen>`.** A pathless `mlo.exe -AddSubtask="..." -console` against an open GUI can **silently no-op with exit 0** (reproduced twice after an app restart; consistent with the forward routing against the registry's `LastDBFile`, which is stale after an in-app profile switch — see ADR-0004). The explicit path fixed it both times.
   - **Any file argument that isn't the open file bypasses forwarding.** A malformed invocation whose caption parses as `<FileToOpen>` (e.g. a missing `=`) launches a **second MLO instance** on the nonexistent file ("File not found") instead of forwarding to the running one.
4. **Concurrent invocations race the `.ml` file** ("file is locked by another process" dialog + hang). Serialize all invocations — across processes, not just within one.
5. Headless (no GUI running) everything is clean: `-AddSubtask` targets the top level, `-task={GUID}` works without side effects, no zoom persistence.

## Verbs

- **Export**: `mlo.exe <file.ml> -saveXML="out.xml" -console` → full task tree + app state (see [xml-format.md](xml-format.md)). With `-task={GUID}`: exports only that subtree.
- **Import/convert**: `mlo.exe <file.xml> -saveML="out.ml" -console` → builds a `.ml` from an XML document. The XML→ML→XML round-trip is **lossless** for task data (verified byte-for-byte modulo a profile timestamp) — this is what makes file-replacement writes viable.
- **Add**: `mlo.exe <file.ml> [-task={parentGUID}] -AddSubtask="<caption>" [-Parse] -console`.
- **Sync**: `mlo.exe <file.ml> -QuickSync -console` — runs the profile's configured cloud/Wi-Fi sync. **Asynchronous in form only**: the invocation forwards to the running app and exits 0 after ~13 s, and the sync session lands in `mlo_log_sync.txt` within that same invocation (measured 2026-08-12, 6.1.3, nine consecutive invocations — an earlier note claiming 40–80 s later did not hold up). Sharper still: **it opens no sync session at all when MLO believes nothing changed** (no local modifications and the background `GetFileTS` poll returning the stored stamp); a manual GUI sync always opens a full session. Do not treat `-QuickSync` returning as evidence a session ran.

  **Client-side rate guard**: MLO throttles the switch with a counter in its own settings, not by anything server-side. Measured 2026-08-12 against 6.1.3, invocations strictly serialized:

  | invocation | exit | `QuickSyncCount` after | sync session? |
  |---|---|---|---|
  | 1-4 | 0, ~13 s each | 1, 2, 3, 4 | yes, every time |
  | 5 | **never exits** | 5 | **none** |

  - **The limit is 4 per window; the 5th invocation trips it.** It pops the modal *"Very frequent synchronization to the cloud in command line mode is not allowed. Please sync no more than once per several minutes..."*, and the CLI process **hangs until killed** — it does not exit when the modal closes. Always spawn with a timeout that kills the child.
  - **The state is `HKCU\Software\MyLifeOrganized.net\MyLife\Settings`**: `QuickSyncCount` (REG_DWORD, invocations this window) and `QuickSyncTime` (REG_BINARY, a Delphi `TDateTime` double — the window stamp). The counter increments on every invocation and resets when the window elapses; writing `QuickSyncCount = 0` clears the throttle immediately (verified), and backdating `QuickSyncTime` does too. **The server reads this counter and never writes it** — forging it would defeat a guard the vendor put there deliberately.
  - The exact window length is still unmeasured. It does not need to be: the server gates on the counter's value (`MLO_QUICKSYNC_MAX_PER_WINDOW`, default 4), so it never needs to know when the window turns over.
  - The wording flags the switch as deprecated, so nothing may depend on it. A skipped nudge loses nothing — queued writes ride MLO's background `GetFileTS` poll and deliver together in one session.

## The `-Parse` rapid-entry parser

`-Parse` runs the caption through MLO's rapid-entry syntax: natural-language dates ("tomorrow 3pm", "next Friday"), `@Context; @Context2`, `-i1..5` importance, `-u1..5` urgency, `-e1..5` effort, `-t`/`-tmax` estimates, `-l` lead, `-s`/`-d` start/due, `-h` hide, `-o` in-order, `-p` project, `-f` folder, `-g` goal, `-fl<Flag>`, `-c<Color>`, `-toprj<Name>`/`-tofld<Name>`/`-to<TaskName>` placement, `+@` add context, `-star`, `remind <when>`. Quoting the caption (`"..."`) shields it from parsing.

**Scale**: `-iN`/`-eN` map to `(N-1)*50` on MLO's internal 0–200 scale (100 = normal).

**Reliability warning**: the parser mis-tokenizes when the (even quote-shielded) caption contains digits — unparsed tokens (dates, contexts) fold back into the caption. Prefer exact XML writes for anything beyond a plain caption; treat parser results as best-effort and always verify what was actually created.

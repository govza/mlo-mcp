# Manual runbook: the conflict rounds

The one part of the write path no unattended suite can run. Everything else the
spec calls `verify-live` is automated in the `mlo` project behind `MLO_LIVE=1`
(`mcp-server/test/mlo/live-write.test.ts`); the conflict rounds need a human in
front of the app, because MLO's **"Resolve Sync Conflict"** window opens
mid-session and holds the sync open until somebody answers it.

The machine-side halves of the two outcomes are already automated as fake
transitions in `unit` (`FakeMloRepository`: delivered-by-UID with differing
content → `superseded`, never `verified`; Get seen with no Apply → the
session-held-open gauge). What this runbook adds is the evidence that MLO
behaves the way those fakes assume.

The unattended suite runs as:

```powershell
cd mcp-server
$env:MLO_LIVE = "1"; $env:MLO_LIVE_DATA_FILE = "<path to the demo .ml>"
# optional: MLO_LIVE_CLOUD_PORT (default 8282), MLO_LIVE_FINDINGS (default %TEMP%\mlo-live-findings.jsonl)
pnpm test:mlo
```

Findings it cannot assert - the `GetFileTS` nudge failing to induce a session, a
sync beating the TTL window - are appended to the findings file as JSON lines,
which is the artefact to read after the run.

Source of the recipe: wayfinder tickets
`.scratch/rearchitecture/issues/05-prototype-write-channel.md` (harness runbook)
and `13-gui-side-effects-conflict.md` (the live HITL session that first observed
the dialog).

## Setup (once per session)

1. **A disposable profile.** Use the Demo profile, not a real one — every round
   below mutates the profile *and* the vendor-side cloud file behind it.
2. Open that profile in MLO and leave the app open (the dialog only exists in
   the GUI).
3. In its cloud sync profile settings: proxy host `127.0.0.1`, port `8282`,
   **"Use secure connection" UNCHECKED**. A `CONNECT` line in the resident's
   summary log means secure is still on and nothing below will work.
4. Start the resident on that port against a scratch state root:

   ```powershell
   cd mcp-server
   $env:MLO_CLOUD_PORT = "8282"
   $env:MLO_CLOUD_STATE_ROOT = "$env:TEMP\mlo-conflict-runbook"
   pnpm dev --data-file="<path to the demo .ml>"
   ```

5. Sync once from the GUI (or `mlo.exe "<demo.ml>" -QuickSync -console`) so the
   profile binds. Confirm with `curl http://127.0.0.1:8282/v1/status` — the
   partition list must carry the demo cloud file's UID.

Queue writes with `POST /v1/write` (`{ profile, rows }`, section-addressed
rows), and read receipts with `GET /v1/write/<writeId>`. The live suite's
helpers show both shapes; `pnpm tool` drives the MCP tools instead if you want
the tool-level view.

## Round 1 — remote wins (the injected write survives)

1. In the GUI, edit a task's caption. **Do not sync.**
2. Queue an update to the **same UID** with a *different* caption.
3. Sync (GUI Sync, or QuickSync — the local edit guarantees a session).
4. **Expect:** the "Resolve Sync Conflict" window opens between the Get and the
   Apply, one row per conflicted item, Action column defaulting to `<- Replace`
   (remote/injected wins). Leave the default, press OK.
5. **Expect:** the session finishes cleanly, the injected caption is what the
   outline shows, MLO re-uploads it, and `write_status` reads `delivered`
   (later `verified`).

Record: did the dialog appear, how long the session stayed open, the final
status, and whether the main window stayed usable behind the dialog (it did in
the 2026-07-27 session — the dialog is not app-modal).

## Round 2 — local wins (`superseded`, the load-bearing one)

1. Same setup: GUI edit, no sync, queue a different update to the same UID.
2. Sync. When the dialog opens, **toggle the Action to keep Local**, press OK.
3. **Expect:** MLO uploads its *own* row for that UID. The Apply still carries
   the injected UID with `result=true` — so UID-based tracking alone would call
   this a success.
4. **Expect from the resident:** because the Apply-observation path compares row
   *content*, the receipt reads **`superseded`**, never `delivered`/`verified`,
   and the write appears in `cloud_status`'s `recentDeadLetters` with the
   supersede reason. No retry is attempted (re-injecting would just re-raise the
   dialog).

This is the discrimination the whole content-compare exists for: if a
local-wins round ever reads as `delivered`, the compare has regressed.

## Round 3 — the session-held-open gauge

1. Queue any write, then trigger the conflict dialog again (GUI edit + a
   competing update on the same UID).
2. When the dialog opens, **leave it open for more than 30 seconds** without
   answering.
3. **Expect:** `GET /v1/status` lists the write under `writesHeldOpen`, and
   `cloud_status` reports `sessionHeldOpen: true` — "delivery stalled, likely
   awaiting user input in MLO". Nothing queued behind the session delivers
   until the dialog is answered.
4. Answer the dialog; the gauge clears and delivery resumes.

## Cleanup

Delete the test tasks from the demo profile, sync once so the vendor side
matches, point the profile's proxy settings back where they belong, and stop the
resident. The scratch state root is disposable.

## What to write down

For each round: whether the dialog appeared, its Action default, the answer
given, MLO's own session duration (from
`%LOCALAPPDATA%\MyLifeOrganized\Logs\mlo_log_sync.txt`), the receipt status the
resident reported, and any GUI side effect (selection jump, focus theft, lost
expansion state — none observed so far). Deviations from the expectations above
are spec-level findings, not test flakes: the error contract's
`write-superseded` kind and the session-held-open gauge rest on them.

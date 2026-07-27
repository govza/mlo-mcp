# mlo-mcp

MCP server that lets AI agents manage tasks in the **MyLifeOrganized** (MLO) Windows desktop app, driving `mlo.exe`'s command line — no cloud API involved.

Full reference documentation lives in [`../docs/`](../docs/README.md): the mlo.exe CLI, the XML and `.ml` binary formats, and the server architecture. The server itself is methodology-neutral; customizable skills that layer GTD workflows on top of these tools live in a separate `gtd-skills` repo.

**Installing the server as a user?** See the [root README](../README.md) — end users need only Node, not pnpm: the repo ships a committed single-file bundle (`dist-bundle/mlo-mcp.js`, dependency-free) usable from any MCP client. It also carries the two-step install, including the one-time proxy wiring that writes depend on. This file covers development.

## Requirements (development)

- Windows with MLO desktop installed (default path `C:\Program Files (x86)\MyLifeOrganized.net\MLO\mlo.exe`)
- Node 22+, pnpm

## Dev setup

```powershell
cd mcp-server
pnpm install
pnpm build     # tsc → dist/ (what the e2e tests and a local registration run)
pnpm bundle    # esbuild → dist-bundle/mlo-mcp.js (the committed single-file distribution — rebuild and commit when src/ changes)
```

Register your working copy with Claude Code:

```powershell
claude mcp add mlo -- node D:\dev\projects\oml\mlo-mcp\mcp-server\dist\index.js
```

### Configuration (env vars)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MLO_EXE_PATH` | no | Program Files path above | mlo.exe location |
| `MLO_EXPORT_DIR` | no | `%TEMP%\mlo-mcp` | Scratch dir for XML exports |
| `MLO_CACHE_STALE_MS` | no | `30000` | Task-tree cache lifetime |
| `MLO_CLOUD_HOST` | no | `127.0.0.1` | Local sync endpoint bind address (loopback only by design) |
| `MLO_CLOUD_PORT` | no | `8181` | Local sync endpoint port (`0` = random); MLO profiles configured against the old 8080 default need their sync URL/proxy updated |
| `MLO_CLOUD_STATE_ROOT` | no | `%LOCALAPPDATA%\mlo-mcp\cloud` | Partitioned sync-state root (override for tests/unusual installs only) |
| `MLO_WRITE_TTL_MINUTES` | no | `15` | How long an accepted write may wait for MLO's Apply before it expires into the dead-letter record |
| `MLO_INBOX_CAPTION` | no | MLO's own `<Inbox>` | Caption of the task acting as the capture inbox, for profiles with a hand-made one |

There is no profile setting. The server operates on the profile MLO itself
has open, logs the detected path to stderr on startup, and refuses to start
when it cannot establish one. This isn't just convenience — reads drive
`mlo.exe` and writes ride the open profile's sync, so the app's current
profile is the only one the server can fully operate on.

Detection does not simply trust the registry. The `LastDBFile` value under
`HKCU\Software\MyLifeOrganized.net\MyLife\Settings` supplies a *candidate*,
which is then checked against the running MLO — because MLO writes that value
when it **exits**, not when it opens a profile, so it goes stale the moment
you switch profiles in the app. The running app is asked two questions the
registry cannot answer: what its window title says it has open, and whether
it is actually holding the candidate file open. If either answer contradicts
the candidate, the server **refuses to start** and names both the stale path
and what MLO really has open, rather than silently reading the wrong task
tree and queueing writes against the wrong profile's sync
([ADR-0004](../docs/adr/0004-ground-truth-the-open-profile.md)). Fix a
refusal by switching back to that profile in MLO, or by closing and reopening
MLO so it records the profile you are actually using.

It also follows profile switches: a background check (every 60s) notices when
MLO opens a different profile — or stops having this one open — and exits
while idle, so the MCP client respawns the server against the current profile
on the next tool call. (The test suite, which runs `mlo.exe` on temp copies
with the GUI closed, pins its profile with an internal `--data-file=`
argument; that bypasses these checks and disables the switch-following.)

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `list_tasks` | read | tree/flat outline + structured data |
| `search_tasks` | read | text, context, due range, star, completion, project, flag |
| `get_task` | read | full fields, GUID, children, dependencies |
| `list_contexts` | read | contexts (Places) with usage counts |
| `write_status` | read | where one accept receipt got to, by `writeId`: accepted/delivered/verified/expired/superseded |
| `cloud_status` | read | binding + partition lifecycle, endpoint reachability and build, binding mismatch, the write aggregate |
| `capture_task` | write | rapid entry: one line into the profile's `<Inbox>`, trailing `@context` tokens, note after a blank line |
| `add_task` | write | one full-row task per call; parent by Path id; booleans, existing Flag/Places |
| `add_tasks` | write | atomic 1–50 task outline; batch-local parent/dependency keys + links to existing tasks |
| `move_task` | write | re-parent a task with its whole subtree, optionally into a slot among new siblings |
| `sync` | write | `-QuickSync`; never load-bearing |
| `complete_task` | destructive | `ids` batch, one delta; refuses recurring tasks |
| `uncomplete_task` | destructive | reopens completed tasks, `ids` batch |
| `update_task` | destructive | `updates` batch: fields, booleans, Flag/Places/dependencies + re-parenting |
| `delete_task` | destructive | tombstones each task + whole subtree, `ids` batch |

Writes never touch the data file. Each write travels as a complete sync delta, durably queued in the resident endpoint and then injected into the app's **own** next sync session, so **MLO's own merge logic** applies it while the app keeps running — the server never uploads to the vendor itself. Batches travel as ONE delta and are atomic (one bad id and nothing is queued). A write tool answers at durable accept — `{ uid, writeId, status: "accepted", expiresAt, message }` — and `write_status(writeId)` is where the outcome lives.

**One-time setup per profile:** back up the `.ml`, wire MLO's cloud sync proxy to the endpoint ("Use secure connection" unchecked), and run one ordinary sync. That is all: behind three guards the resident then pulls the account's complete cloud history — so every pre-existing task gets its stable UID and full record — and binds the profile, writing the binding last. Until a binding exists, mutation tools refuse with the guard that stopped them; the binding itself is persisted, so it survives restarts (the captured account contact is not, so a rebooted machine needs one more proxied sync before another initialization could run). Written out step by step as Step 2 of the [root README](../README.md#step-2--enable-writes-one-time-per-profile); the rationale and failure modes are in [`../docs/mcp-cloud.md`](../docs/mcp-cloud.md), the tool semantics in [`../docs/tools.md`](../docs/tools.md). The server also sends a connection-time `instructions` guide teaching agents these conventions.

Task ids are path-based (`1.2.3`) and shift when the tree changes — the server re-exports before every mutation, and `get_task` also reports each task's stable internal GUID, resolved by aligning the export against the row store the endpoint captured from MLO's sync traffic, with the binary `.ml` recovery as cross-check.

## Tests & direct tool runs

```powershell
pnpm test:unit   # no MLO needed
pnpm test:mlo    # requires MLO installed and the GUI closed; runs on a temp copy
pnpm test        # both
```

`pnpm tools` prints the catalog — every tool an MCP client would see, grouped by
kind, with parameters read straight off the zod schemas (so it cannot drift from
the code). It needs neither MLO nor a profile:

```powershell
pnpm tools                 # all tools: one-line summary + params ("?" = optional)
pnpm tools add_task        # one tool: full input/output schema, hints, a runnable example
pnpm tools --json          # the same catalog as JSON

pnpm tool list_tasks '{"format":"flat"}'   # actually call one (profile auto-detected, like the server)
pnpm tool add_task '{"caption":"Test task"}'
```

**The sync endpoint runs as its own background process** and is started
automatically ([docs/adr/0003](../docs/adr/0003-resident-endpoint.md)). A
session only replaces it when its own version is strictly newer, so **a plain
rebuild does not restart it** — during development, stop it by hand
(`Invoke-WebRequest -Method POST http://127.0.0.1:8181/v1/shutdown -Body '{}'
-ContentType application/json`) after changing anything under `src/cloud/`, or
run one in the foreground with `pnpm exec tsx scripts/serve-cloud.ts` and keep
it there. Sessions and `pnpm tool` both attach to whichever one is up.

## Known quirks (verified against MLO 15.x)

- mlo.exe is Delphi: embedded quotes in arguments must be doubled (`""`), never `\"`-escaped; the server handles this.
- `-console` is required on every invocation or mlo.exe stays resident.
- Importance/Effort are stored 0–200 (100 = normal, omitted from XML).
- MLO's `-Parse` rapid-entry parser mis-tokenizes captions containing digits; the server avoids it unless natural-language dates/parseText are requested.
- `-task={GUID}` while the GUI is open zooms the user's view (and an invalid GUID pops a modal dialog); the server never GUID-targets with the GUI open.

# mlo-mcp

MCP server that lets AI agents manage tasks in the **MyLifeOrganized** (MLO) Windows desktop app, driving `mlo.exe`'s command line — no cloud API involved.

Full reference documentation lives in [`../docs/`](../docs/README.md): the mlo.exe CLI, the XML and `.ml` binary formats, and the server architecture. The server itself is methodology-neutral; customizable skills that layer GTD workflows on top of these tools live in a separate `gtd-skills` repo.

**Installing the server as a user?** See the [root README](../README.md) — end users need only Node, not pnpm: the repo ships a committed self-contained bundle (`dist-bundle/mlo-mcp.js`) usable from any MCP client. This file covers development.

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
claude mcp add mlo -- node D:\dev\projects\oml\mcp-server\dist\index.js
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

There is no profile setting. The server operates on the profile MLO itself
has open — it reads the `LastDBFile` value under
`HKCU\Software\MyLifeOrganized.net\MyLife\Settings` (which MLO updates
whenever it opens a profile), logs the detected path to stderr on startup,
and refuses to start when no profile was ever opened. It also follows profile
switches: a background check (every 60s) notices when MLO opens a different
profile and exits while idle, so the MCP client respawns the server against
the new profile on the next tool call. This isn't just convenience — reads
drive `mlo.exe` and writes ride the open profile's sync, so the app's current
profile is the only one the server can fully operate on. (The test suite,
which runs `mlo.exe` on temp copies with the GUI closed, pins its profile
with an internal `--data-file=` argument; that also disables the
switch-following.)

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `list_tasks` | read | tree/flat outline + structured data |
| `search_tasks` | read | text, context, due range, star, completion, project, flag |
| `get_task` | read | full fields, GUID, children, dependencies |
| `list_contexts` | read | contexts (Places) with usage counts |
| `cloud_status` | read | binding, bootstrap lifecycle, cursor + delta counts, mirror coverage |
| `cloud_bootstrap` | write | one-time setup: pulls the vendor cloud's full history and binds the profile |
| `add_task` | write | one full-row task per call; parent by GUID; booleans, existing Flag/Places |
| `add_tasks` | write | atomic 1–50 task outline; local parent/dependency keys + existing GUID links |
| `sync` | write | `-QuickSync` |
| `complete_task` | destructive | `ids` batch, one delta; refuses recurring tasks |
| `uncomplete_task` | destructive | reopens completed tasks, `ids` batch |
| `update_task` | destructive | `updates` batch: fields, booleans, Flag/Places/dependencies + re-parenting |
| `delete_task` | destructive | tombstones each task + whole subtree, `ids` batch |

Writes never touch the data file. Each write travels as a complete sync delta — normally committed to the real **vendor MLO Cloud** in the server's own sync session (the server proxies the app's cloud sync and additionally acts as one more sync client of the account) and delivered to MLO by the triggered QuickSync; **MLO's own merge logic** applies it while the app keeps running. Batches travel as ONE delta and are atomic (one bad id and nothing is queued). Results carry a `verified` flag — `false` means accepted but not yet confirmed in a fresh export, not failure.

**One-time setup per profile:** back up the `.ml`, wire MLO's cloud sync proxy to the endpoint ("Use secure connection" unchecked), run one ordinary sync, then call `cloud_bootstrap` — it pulls the account's complete cloud history so every pre-existing task gets its stable UID and full record. Until then, mutation tools refuse (an ordinary sync alone never enables writes); after every server restart, one proxied sync is needed before writes resume. See [`../docs/tools.md`](../docs/tools.md) and [`../docs/mcp-cloud.md`](../docs/mcp-cloud.md). The server also sends a connection-time `instructions` guide teaching agents these conventions.

Task ids are path-based (`1.2.3`) and shift when the tree changes — the server re-exports before every mutation, and `get_task` also reports each task's stable internal GUID, resolved by structural alignment of the export outline against the bootstrapped cloud tree (duplicate sibling captions resolve by position).

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

## Known quirks (verified against MLO 15.x)

- mlo.exe is Delphi: embedded quotes in arguments must be doubled (`""`), never `\"`-escaped; the server handles this.
- `-console` is required on every invocation or mlo.exe stays resident.
- Importance/Effort are stored 0–200 (100 = normal, omitted from XML).
- MLO's `-Parse` rapid-entry parser mis-tokenizes captions containing digits; the server avoids it unless natural-language dates/parseText are requested.
- `-task={GUID}` while the GUI is open zooms the user's view (and an invalid GUID pops a modal dialog); the server never GUID-targets with the GUI open.

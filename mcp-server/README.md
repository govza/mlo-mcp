# mlo-mcp

MCP server that lets AI agents manage tasks in the **MyLifeOrganized** (MLO) Windows desktop app, driving `mlo.exe`'s command line — no cloud API involved.

Full reference documentation lives in [`../docs/`](../docs/README.md): the mlo.exe CLI, the XML and `.ml` binary formats, and the server architecture. Customizable skills that layer GTD workflows on top of these tools (the server itself is methodology-neutral) are in [`../skills/`](../skills/README.md).

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
claude mcp add mlo -e MLO_DATA_FILE=D:\path\to\your.ml -- node D:\dev\projects\oml\mcp-server\dist\index.js
```

### Configuration (env vars)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MLO_DATA_FILE` | yes¹ | — | The `.ml` profile the server operates on |
| `MLO_EXE_PATH` | no | Program Files path above | mlo.exe location |
| `MLO_EXPORT_DIR` | no | `%TEMP%\mlo-mcp` | Scratch dir for XML exports |
| `MLO_CACHE_STALE_MS` | no | `30000` | Task-tree cache lifetime |
| `MLO_AUTO_RESTART_GUI` | no | `1` | Close + relaunch a running MLO app around writes; `0` = refuse writes while it runs |
| `MLO_RELAUNCH_STYLE` | no | `minimized` | How MLO comes back after a write: `minimized` (no window pop / focus steal; combines with MLO's "Minimize to system tray" option to be fully invisible), `normal`, or `none` (leave it closed) |

¹ In a repo checkout, `MLO_DATA_FILE` may be omitted — it defaults to the demo
profile at `profile/profile.ml`, so `pnpm dev` / `pnpm tool` work out of the box.
Installs from npm (no `profile/` shipped) still require it.

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `list_tasks` | read | tree/flat outline + structured data |
| `search_tasks` | read | text, context, due range, star, completion, project, flag |
| `get_task` | read | full fields, GUID, children, dependencies |
| `list_contexts` | read | contexts (Places) with usage counts |
| `add_task` | write | single task or a `tasks` batch (each with own parent/fields/subtree), one write; MLO rapid-entry parser only for natural-language dates/urgency/parseText |
| `sync` | write | `-QuickSync` |
| `complete_task` | destructive | `ids` batch, one write |
| `uncomplete_task` | destructive | reopens completed tasks, `ids` batch |
| `update_task` | destructive | `updates` batch: field edits, moves, dependencies |
| `delete_task` | destructive | removes subtrees, `ids` batch |

Write tools take **batches** and apply the whole batch in one data-file round-trip (atomic: one bad id and nothing changes) — this matters because every write may restart the MLO app. The server also sends a connection-time `instructions` guide teaching agents these conventions.

Destructive tools rewrite the data file via `export → edit XML → -saveML → replace`, keep a timestamped `.bak-*` next to the file, verify by re-export, and restore the backup on mismatch. The running MLO app would overwrite such a change from memory, so when the app is open the server **closes it gracefully (MLO saves on close, same as clicking X), applies the write, and relaunches it** — set `MLO_AUTO_RESTART_GUI=0` to refuse writes instead. Reads and bare-caption adds never touch the app.

Task ids are path-based (`1.2.3`) and shift when the tree changes — the server re-exports before every mutation, and `get_task` also reports each task's stable internal GUID (recovered from the `.ml` binary; recurring tasks may lack one).

## Tests & direct tool runs

```powershell
pnpm test:unit   # no MLO needed
pnpm test:mlo    # requires MLO installed and the GUI closed; runs on a temp copy
pnpm test        # both
```

`pnpm tools` prints the catalog — every tool an MCP client would see, grouped by
kind, with parameters read straight off the zod schemas (so it cannot drift from
the code). It needs neither MLO nor `MLO_DATA_FILE`:

```powershell
pnpm tools                 # all tools: one-line summary + params ("?" = optional)
pnpm tools add_task        # one tool: full input/output schema, hints, a runnable example
pnpm tools --json          # the same catalog as JSON

pnpm tool list_tasks '{"format":"flat"}'   # actually call one (needs MLO_DATA_FILE)
pnpm tool add_task '{"caption":"Test task"}'
```

## Known quirks (verified against MLO 15.x)

- mlo.exe is Delphi: embedded quotes in arguments must be doubled (`""`), never `\"`-escaped; the server handles this.
- `-console` is required on every invocation or mlo.exe stays resident.
- Importance/Effort are stored 0–200 (100 = normal, omitted from XML).
- MLO's `-Parse` rapid-entry parser mis-tokenizes captions containing digits; the server avoids it unless natural-language dates/parseText are requested.
- `-task={GUID}` while the GUI is open zooms the user's view (and an invalid GUID pops a modal dialog); the server never GUID-targets with the GUI open.

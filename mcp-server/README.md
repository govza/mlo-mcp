# mlo-mcp

MCP server that lets AI agents manage tasks in the **MyLifeOrganized** (MLO) Windows desktop app, driving `mlo.exe`'s command line — no cloud API involved.

Full reference documentation lives in [`../docs/`](../docs/README.md): the mlo.exe CLI, the XML and `.ml` binary formats, and the server architecture.

## Requirements

- Windows with MLO desktop installed (default path `C:\Program Files (x86)\MyLifeOrganized.net\MLO\mlo.exe`)
- Node 22+, pnpm

## Setup

```powershell
cd mcp-server
pnpm install
pnpm build
```

Register with Claude Code:

```powershell
claude mcp add mlo -e MLO_DATA_FILE=D:\path\to\your.ml -- node D:\dev\projects\oml\mcp-server\dist\index.js
```

### Configuration (env vars)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `MLO_DATA_FILE` | yes | — | The `.ml` profile the server operates on |
| `MLO_EXE_PATH` | no | Program Files path above | mlo.exe location |
| `MLO_EXPORT_DIR` | no | `%TEMP%\mlo-mcp` | Scratch dir for XML exports |
| `MLO_CACHE_STALE_MS` | no | `30000` | Task-tree cache lifetime |
| `MLO_AUTO_RESTART_GUI` | no | `1` | Close + relaunch a running MLO app around writes; `0` = refuse writes while it runs |

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `list_tasks` | read | tree/flat outline + structured data |
| `search_tasks` | read | text, context, due range, star, completion, project, flag |
| `get_task` | read | full fields, GUID, children |
| `add_task` | write | exact XML insert when MLO is closed; MLO rapid-entry parser otherwise |
| `sync` | write | `-QuickSync` |
| `complete_task` | destructive | XML round-trip rewrite |
| `update_task` | destructive | field edits by id |
| `delete_task` | destructive | removes subtree |

Destructive tools rewrite the data file via `export → edit XML → -saveML → replace`, keep a timestamped `.bak-*` next to the file, verify by re-export, and restore the backup on mismatch. The running MLO app would overwrite such a change from memory, so when the app is open the server **closes it gracefully (MLO saves on close, same as clicking X), applies the write, and relaunches it** — set `MLO_AUTO_RESTART_GUI=0` to refuse writes instead. Reads and bare-caption adds never touch the app.

Task ids are path-based (`1.2.3`) and shift when the tree changes — the server re-exports before every mutation, and `get_task` also reports each task's stable internal GUID (recovered from the `.ml` binary; recurring tasks may lack one).

## Tests

```powershell
pnpm test:unit   # no MLO needed
pnpm test:mlo    # requires MLO installed and the GUI closed; runs on a temp copy
pnpm test        # both
```

## Known quirks (verified against MLO 15.x)

- mlo.exe is Delphi: embedded quotes in arguments must be doubled (`""`), never `\"`-escaped; the server handles this.
- `-console` is required on every invocation or mlo.exe stays resident.
- Importance/Effort are stored 0–200 (100 = normal, omitted from XML).
- MLO's `-Parse` rapid-entry parser mis-tokenizes captions containing digits; the server avoids it unless natural-language dates/parseText are requested.
- `-task={GUID}` while the GUI is open zooms the user's view (and an invalid GUID pops a modal dialog); the server never GUID-targets with the GUI open.

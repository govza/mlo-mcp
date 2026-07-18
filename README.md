# mlo-mcp

MCP server for the **MyLifeOrganized** (MLO) Windows desktop app. AI agents (Claude Code, Codex, Cursor, Claude Desktop — anything that speaks MCP over stdio) manage your MLO task tree by driving `mlo.exe`'s undocumented command line locally. No cloud API, no account, your data never leaves the machine.

- 10 tools: list/search/get tasks, contexts, add/update/complete/uncomplete/delete (all writes batched & atomic), QuickSync
- Writes go through a verified rewrite pipeline: export → edit XML → re-import → verify, with a timestamped backup next to your data file and automatic restore on mismatch
- If the MLO app is open, writes close it gracefully (it saves on close) and relaunch it minimized afterwards
- Ships a customizable [GTD-conventions skill](skills/README.md) for Claude Code

## Requirements

- Windows with [MyLifeOrganized](https://www.mylifeorganized.net/) desktop installed
- Node 22+ (that's all — the repo ships a self-contained bundle; no package manager needed)

## Install

The only required setting is `MLO_DATA_FILE` — the path to your `.ml` profile. **Try it against a copy of your profile first** if you're cautious; the server also keeps a `.bak-*` backup next to the file for every write.

### Any MCP client (via npx, straight from GitHub — no npm registry)

```jsonc
{
  "mcpServers": {
    "mlo": {
      "command": "npx",
      "args": ["-y", "github:govza/mlo-mcp"],
      "env": { "MLO_DATA_FILE": "C:\\path\\to\\your.ml" }
    }
  }
}
```

npx caches the GitHub install; pin a tag (`github:govza/mlo-mcp#v0.2.0`) for reproducibility, and re-run with a newer tag to update.

### Claude Code

Either register directly:

```powershell
claude mcp add mlo -e MLO_DATA_FILE=C:\path\to\your.ml -- npx -y github:govza/mlo-mcp
```

or install as a plugin (also ships the GTD skills; updates via `/plugin update`):

```
/plugin marketplace add govza/mlo-mcp
/plugin install mlo@govza
```

The plugin reads `MLO_DATA_FILE` from your environment — set it once, user-level:

```powershell
[Environment]::SetEnvironmentVariable("MLO_DATA_FILE", "C:\path\to\your.ml", "User")
```

### From a clone (no npx)

```powershell
git clone https://github.com/govza/mlo-mcp
claude mcp add mlo -e MLO_DATA_FILE=C:\path\to\your.ml -- node C:\path\to\mlo-mcp\mcp-server\dist-bundle\mlo-mcp.js
```

### Configuration

`MLO_DATA_FILE` is required; optional vars (`MLO_EXE_PATH`, `MLO_AUTO_RESTART_GUI`, `MLO_RELAUNCH_STYLE`, …) are documented in [`mcp-server/README.md`](mcp-server/README.md).

## Documentation

| | |
|---|---|
| [`mcp-server/`](mcp-server/README.md) | Tools reference, configuration, development, tests |
| [`docs/`](docs/README.md) | The reverse-engineered mlo.exe CLI, XML & `.ml` binary formats, server architecture, MLO task model |
| [`skills/`](skills/README.md) | Customizable Claude Code skill for GTD conventions |

Everything in `docs/` was verified empirically against MLO 15.x on Windows — MLO's CLI is largely undocumented, so the quirk catalog there is the map of what actually works.

## License

MIT

# mlo-mcp

MCP server for the **MyLifeOrganized** (MLO) Windows desktop app. AI agents (Claude Code, Codex, Cursor, Claude Desktop — anything that speaks MCP over stdio) manage your MLO task tree by driving `mlo.exe`'s undocumented command line locally. No cloud API, no account, your data never leaves the machine.

- 12 tools: list/search/get tasks, contexts, single/atomic-outline add, update/complete/uncomplete/delete, QuickSync, cloud status
- Writes never touch your data file: the server runs a local cloud-sync endpoint, queues changes as sync deltas, and MLO's **own** merge logic applies them via QuickSync — the app keeps running, and the append-only delta log is the durable record of every change (see [docs/mcp-cloud.md](docs/mcp-cloud.md), including the one-time proxy wiring that routes the app's sync to the local endpoint)
- Ships four customizable [GTD skills](skills/README.md) (`/mind`, `/inbox`, `/weekly` + standing conventions) for any SKILL.md-capable agent

## Requirements

- Windows with [MyLifeOrganized](https://www.mylifeorganized.net/) desktop installed
- Node 22+ (that's all — the repo ships a self-contained bundle; no package manager needed)

## Install

No configuration: the server operates on whatever profile MLO currently has open (auto-detected from MLO's own settings in the registry, followed across profile switches). **Try it with a copy of your profile first** if you're cautious — just open the copy in MLO; writes are applied by MLO's own sync merge, and every change is kept as a delta in the local message log.

### Any MCP client (via npx, straight from GitHub — no npm registry)

```jsonc
{
  "mcpServers": {
    "mlo": {
      "command": "npx",
      "args": ["-y", "github:govza/mlo-mcp"]
    }
  }
}
```

npx caches the GitHub install; pin a tag (`github:govza/mlo-mcp#v0.2.0`) for reproducibility, and re-run with a newer tag to update.

### Claude Code

Either register directly:

```powershell
claude mcp add mlo -- npx -y github:govza/mlo-mcp
```

or install as a plugin (also ships the GTD skills; updates via `/plugin update`):

```
/plugin marketplace add govza/mlo-mcp
/plugin install mlo@govza
```

The plugin needs no configuration either.

### Skills (any agent)

The GTD skills install with the open [agent-skills CLI](https://github.com/vercel-labs/skills) — one command covers Claude Code, Codex, Cursor, and the rest of the SKILL.md ecosystem:

```powershell
npx skills add govza/mlo-mcp    # update: npx skills update · remove: npx skills remove
```

Claude Code users who install the plugin above get the skills bundled with it instead. See [`skills/`](skills/README.md) for what they do and how to customize them.

### From a clone (no npx)

```powershell
git clone https://github.com/govza/mlo-mcp
claude mcp add mlo -- node C:\path\to\mlo-mcp\mcp-server\dist-bundle\mlo-mcp.js
```

### Configuration

None required. The env vars that exist (`MLO_EXE_PATH`, `MLO_CLOUD_PORT`, … — all optional) are documented in [`mcp-server/README.md`](mcp-server/README.md), along with the one-time `cloud_bootstrap` setup (back up your `.ml` profile first).

## Documentation

| | |
|---|---|
| [`mcp-server/`](mcp-server/README.md) | Tools reference, configuration, development, tests |
| [`docs/`](docs/README.md) | The reverse-engineered mlo.exe CLI, XML & `.ml` binary formats, server architecture, MLO task model |
| [`skills/`](skills/README.md) | Customizable GTD skills (Claude Code, Codex, any SKILL.md-capable agent) |

Everything in `docs/` was verified empirically against MLO 15.x on Windows — MLO's CLI is largely undocumented, so the quirk catalog there is the map of what actually works.

## Disclaimer

Independent project for interoperability and personal use — not affiliated with,
authorized by, or endorsed by the makers of MyLifeOrganized. "MyLifeOrganized"
and "MLO" are trademarks of their respective owner, used here only to name the
app this project interoperates with. It drives a copy of the app you already
license and installed, on your own machine and data.

## License

MIT

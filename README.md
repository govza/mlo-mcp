# mlo-mcp

MCP server for the **MyLifeOrganized** (MLO) Windows desktop app. AI agents (Claude Code, Codex, Cursor, Claude Desktop — anything that speaks MCP over stdio) manage your MLO task tree by driving `mlo.exe`'s undocumented command line locally. No cloud API, no account, your data never leaves the machine.

- 13 tools: list/search/get tasks, contexts, single/atomic-outline add, update/complete/uncomplete/delete, QuickSync, cloud status/bootstrap
- Writes never touch your data file: the server runs a local cloud-sync endpoint, queues changes as sync deltas, and MLO's **own** merge logic applies them via QuickSync — the app keeps running, and the append-only delta log is the durable record of every change
- Methodology-neutral: the server ships primitives only. Opinionated GTD workflow skills (mindsweep, inbox processing, weekly review, standing conventions) live in a separate `gtd-skills` repo

## Install

Installing is two steps. **Step 1 gets you reading** — tools that list, search and inspect tasks work as soon as the server is registered. **Step 2 enables writing**, and it is a one-time setup per profile that cannot be skipped: until it is done, every tool that changes anything refuses.

### Requirements

- Windows with [MyLifeOrganized](https://www.mylifeorganized.net/) desktop installed
- Node 22+ — that's all. The repo ships a committed single-file bundle, so there is no package manager and no dependency install.

### Step 1 — Register the server with your MCP client

There is no profile setting. The server operates on whatever profile MLO currently has open (auto-detected from MLO's own settings in the registry) and follows you across profile switches.

**Any MCP client** (via npx, straight from GitHub — no npm registry):

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

npx caches the GitHub install; pin a tag (`github:govza/mlo-mcp#v0.3.0`) for reproducibility, and re-run with a newer tag to update.

**Claude Code** — either register directly:

```powershell
claude mcp add mlo -- npx -y github:govza/mlo-mcp
```

or install as a plugin (updates via `/plugin update`):

```
/plugin marketplace add govza/mlo-mcp
/plugin install mlo@govza
```

**From a clone** (no npx):

```powershell
git clone https://github.com/govza/mlo-mcp
claude mcp add mlo -- node C:\path\to\mlo-mcp\mcp-server\dist-bundle\mlo-mcp.js
```

Read tools work now. Ask your agent to list your tasks to confirm.

### Step 2 — Enable writes (one-time per profile)

Writes are applied by MLO's own sync merge rather than by editing your data file, so the server has to sit in the app's sync path before it can change anything. Until this is finished, `add_task`, `update_task`, `complete_task` and friends all refuse with a pointer back here — an ordinary sync alone never enables them.

1. **Back up your `.ml` profile** — a file copy while MLO is closed. Do this before the first bootstrap and before any sync experimentation. If you'd rather rehearse, open a *copy* of your profile in MLO and run the whole procedure against that.
2. **Point MLO's cloud sync through the local endpoint:** set the sync profile's proxy to `127.0.0.1:8181`, and leave **"Use secure connection" unchecked**. This matters: with it checked MLO still syncs fine, but the endpoint only sees an opaque TLS tunnel, so bootstrap and every write silently stay dead. MLO's sync log prints *"secure connection is OFF for this sync profile"* when it is set correctly.
3. **Run one ordinary sync in MLO** (or call the `sync` tool).
4. **Call `cloud_bootstrap`** — just ask your agent to run it. It pulls your account's complete cloud history so every pre-existing task gets its stable UID and full record.

Writes are live from here. Two things worth knowing:

- **One ordinary proxied sync arms writes until the sync endpoint restarts** — the account contact is held in memory only, never written to disk. The endpoint is a background process that outlives your agent sessions, so closing or restarting a client does not disarm anything; a reboot does.
- `cloud_status` reports the binding, the bootstrap lifecycle, the endpoint's cursor and whether the endpoint is up whenever you want to check where things stand.

The full rationale, the merge rules, and what each failure mode looks like are in [docs/mcp-cloud.md](docs/mcp-cloud.md).

### Configuration

None required. The env vars that exist (`MLO_EXE_PATH`, `MLO_CLOUD_PORT`, … — all optional) are documented in [`mcp-server/README.md`](mcp-server/README.md).

## Documentation

| | |
|---|---|
| [`mcp-server/`](mcp-server/README.md) | Tools reference, configuration, development, tests |
| [`docs/`](docs/README.md) | The reverse-engineered mlo.exe CLI, XML & `.ml` binary formats, server architecture, MLO task model |

Everything in `docs/` was verified empirically against MLO 15.x on Windows — MLO's CLI is largely undocumented, so the quirk catalog there is the map of what actually works.

## Disclaimer

Independent project for interoperability and personal use — not affiliated with,
authorized by, or endorsed by the makers of MyLifeOrganized. "MyLifeOrganized"
and "MLO" are trademarks of their respective owner, used here only to name the
app this project interoperates with. It drives a copy of the app you already
license and installed, on your own machine and data.

## License

MIT

# mlo-mcp

MCP server for the **MyLifeOrganized** (MLO) Windows desktop app. AI agents (Claude Code, Codex, Cursor, Claude Desktop — anything that speaks MCP over stdio) manage your MLO task tree by driving `mlo.exe`'s undocumented command line locally. No cloud API, no account, your data never leaves the machine.

- 15 tools: list/search/get tasks, contexts, rapid capture, single/atomic-outline add, update/complete/uncomplete/move/delete, write status, QuickSync, cloud status
- Writes never touch your data file: the server runs a local sync endpoint that queues each change as a sync delta and hands it to MLO inside the app's *own* next sync session, so MLO's **own** merge logic applies it — the app keeps running, and every accepted write has a receipt you can look up
- Methodology-neutral: the server ships primitives only. Opinionated GTD workflow skills (mindsweep, inbox processing, weekly review, standing conventions) live in a separate `gtd-skills` repo

## Install

Installing is two steps. **Step 1 gets you reading** — tools that list, search and inspect tasks work as soon as the server is registered. **Step 2 enables writing**, and it is a one-time setup per profile that cannot be skipped: until it is done, every tool that changes anything refuses.

### Requirements

- Windows with [MyLifeOrganized](https://www.mylifeorganized.net/) desktop installed
- Node 22+ — that's all. The repo ships a committed single-file bundle, so there is no package manager and no dependency install.

### Step 1 — Register the server with your MCP client

There is no profile setting. The server operates on whatever profile MLO currently has open (auto-detected by asking the running app itself) and follows you across profile switches. Keep MLO running — it is the only thing that knows which profile is open.

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

or once for every project, at user scope:

```powershell
claude mcp add -s user mlo -- npx -y github:govza/mlo-mcp
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

Writes are applied by MLO's own sync merge rather than by editing your data file, so the server has to sit in the app's sync path before it can change anything. Until this is finished, `add_task`, `update_task`, `complete_task` and friends all refuse, each naming what is still missing.

1. **Back up your `.ml` profile** — a file copy while MLO is closed. Do this before the first sync through the endpoint and before any sync experimentation. If you'd rather rehearse, open a *copy* of your profile in MLO and run the whole procedure against that.
2. **Open MLO with your profile, then start one agent session** (any client from Step 1). The session brings up the local sync endpoint in the background — and it has to be up *before* the next step, because MLO validates your cloud login through the proxy the moment you set it. The endpoint just passes your login through to MLO's cloud; nothing about your account changes.
3. **Point MLO's cloud sync through the local endpoint:** set the sync profile's proxy to `127.0.0.1:8181`, and leave **"Use secure connection" unchecked**. This matters: with it checked MLO still syncs fine, but the endpoint only sees an opaque TLS tunnel, so setup and every write silently stay dead. MLO's sync log prints *"secure connection is OFF for this sync profile"* when it is set correctly.
4. **Press Sync in MLO** — the ordinary QuickSync button, nothing more. The endpoint recognizes your cloud file, checks that it really is the profile MLO has open, pulls your account's complete history so every pre-existing task gets its stable UID and full record, and only then binds. No MLO restart, no "clear cloud data", no full resync — one regular sync from the UI is the whole handshake.

Ask your agent to check `cloud_status` to confirm: it should report the profile bound and ready — and if it is not, it now says why the last bind attempt declined.

Writes are live from here. Three things worth knowing:

- **A write returns as soon as it is durably queued, not when MLO has applied it.** MLO picks it up on its own next sync — usually within about 90 seconds, which the endpoint nudges along. `write_status` tells you where a given write got to.
- **The setup survives client restarts.** The endpoint is a background process that outlives your agent sessions; your account credentials stay in its memory and are never written to disk, so a reboot means one more ordinary sync before writes work again. After a reboot the endpoint returns with your first agent session; MLO syncs attempted before that simply fail to connect and retry later, harmlessly.
- `cloud_status` reports the binding, the partition lifecycle, whether the endpoint is up, and the write queue's health whenever you want to check where things stand.

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

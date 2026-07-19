# Documentation

Reference documentation for the `mlo-mcp` project — an MCP server that lets AI agents manage tasks in the MyLifeOrganized (MLO) Windows desktop app by driving `mlo.exe`'s command line.

| Document | Contents |
|---|---|
| [mlo-cli.md](mlo-cli.md) | The `mlo.exe` command line: switches, exit codes, IPC behavior, and every quirk we verified |
| [xml-format.md](xml-format.md) | The MLO XML export/import schema: element reference, Delphi conventions, dependencies, round-trip rules |
| [ml-binary-format.md](ml-binary-format.md) | The `.ml` data-file binary format and how per-task GUIDs are recovered from it |
| [server-architecture.md](server-architecture.md) | How the MCP server is built: locking, write pipeline, GUI auto-restart, tool design |
| [mlo-task-model.md](mlo-task-model.md) | MLO's task model & GTD concepts distilled from the bundled help: computed-score priority, importance/urgency, contexts, dependencies, visibility, input parsing, shortcuts |
| [cloud-sync.md](cloud-sync.md) | The cloud-sync data plane, observed empirically: ZIP/`data.csv` delta envelopes, CSV sections, logical cursor semantics |
| [mcp-cloud.md](mcp-cloud.md) | The local cloud-sync endpoint: wire contract, delta log, merge rules, how the app gets wired to it via MLO's proxy setting |
| [mitm-proxy.md](mitm-proxy.md) | Debug-only mitmproxy workflow — the TLS-interception fallback if vendor sync traffic turns out not to be observable as plain HTTP |

Historical context: `sources/` (git-ignored, local-only) holds the underlying research material these documents distill.

The CLI, format, and architecture docs were **verified empirically on MLO 15.x (Windows, Delphi build)** — MLO's CLI is largely undocumented. The exception is [mlo-task-model.md](mlo-task-model.md), which distills MLO's *own* bundled help (`mlo.chm`) and is therefore vendor-described behavior rather than re-verified.

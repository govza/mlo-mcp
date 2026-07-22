# Documentation

Reference documentation for the `mlo-mcp` project — an MCP server that lets AI agents manage tasks in the MyLifeOrganized (MLO) Windows desktop app by driving `mlo.exe`'s command line.

MCP server (this project):

| Document | Contents |
|---|---|
| [tools.md](tools.md) | The MCP tool surface: what each tool is for, its guarantees and coverage limits (schemas: `pnpm tools`) |
| [server-architecture.md](server-architecture.md) | How the MCP server is built: locking, reads, the queue→QuickSync→verify write loop, tool design |
| [mcp-cloud.md](mcp-cloud.md) | The local cloud-sync endpoint: wire contract, delta log, merge rules, how the app gets wired to it via MLO's proxy setting |

MLO itself — reverse-engineered formats, protocol, and task model ([mlo/](mlo/)):

| Document | Contents |
|---|---|
| [mlo/mlo-cli.md](mlo/mlo-cli.md) | The `mlo.exe` command line: switches, exit codes, IPC behavior, and every quirk we verified |
| [mlo/xml-format.md](mlo/xml-format.md) | The MLO XML export/import schema: element reference, Delphi conventions, dependencies, round-trip rules |
| [mlo/ml-binary-format.md](mlo/ml-binary-format.md) | The `.ml` data-file binary format and how per-task GUIDs are recovered from it |
| [mlo/mlo-task-model.md](mlo/mlo-task-model.md) | MLO's task model & GTD concepts distilled from the bundled help: computed-score priority, importance/urgency, contexts, dependencies, visibility, input parsing, shortcuts |
| [mlo/cloud-sync.md](mlo/cloud-sync.md) | The cloud-sync data plane, observed empirically: ZIP/`data.csv` delta envelopes, CSV sections, logical cursor semantics |
| [mlo/mitm-proxy.md](mlo/mitm-proxy.md) | Debug-only mitmproxy workflow — the TLS-interception fallback if vendor sync traffic turns out not to be observable as plain HTTP |

These documents are an independent, unofficial description derived from the author's own installed client and their own account's sync traffic, for interoperability and personal use — not affiliated with or endorsed by the makers of MyLifeOrganized. Any local-only working material stays git-ignored and out of the repository.

The CLI, format, and architecture docs were **verified empirically on MLO 15.x (Windows, Delphi build)** — MLO's CLI is largely undocumented. The exception is [mlo/mlo-task-model.md](mlo/mlo-task-model.md), which distills MLO's *own* bundled help (`mlo.chm`) and is therefore vendor-described behavior rather than re-verified.

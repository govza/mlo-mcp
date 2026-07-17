# Documentation

Reference documentation for the `mlo-mcp` project — an MCP server that lets AI agents manage tasks in the MyLifeOrganized (MLO) Windows desktop app by driving `mlo.exe`'s command line.

| Document | Contents |
|---|---|
| [mlo-cli.md](mlo-cli.md) | The `mlo.exe` command line: switches, exit codes, IPC behavior, and every quirk we verified |
| [xml-format.md](xml-format.md) | The MLO XML export/import schema: element reference, Delphi conventions, dependencies, round-trip rules |
| [ml-binary-format.md](ml-binary-format.md) | The `.ml` data-file binary format and how per-task GUIDs are recovered from it |
| [server-architecture.md](server-architecture.md) | How the MCP server is built: locking, write pipeline, GUI auto-restart, tool design |

Historical context: `sources/` (git-ignored, local-only) holds the underlying research material these documents distill.

Everything documented here was **verified empirically on MLO 15.x (Windows, Delphi build)** — this is not vendor documentation; MLO's CLI is largely undocumented.

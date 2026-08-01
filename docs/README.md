# Documentation

Reference documentation for the `mlo-mcp` project — an MCP server that lets AI agents manage tasks in the MyLifeOrganized (MLO) Windows desktop app by driving `mlo.exe`'s command line.

MCP server (this project):

| Document | Contents |
|---|---|
| [tools.md](tools.md) | The MCP tool surface: what each tool is for, its guarantees and coverage limits (schemas: `pnpm tools`) |
| [server-architecture.md](server-architecture.md) | How the MCP server is built: the layer model, module map, locking, reads and the write path, the error contract, the test projects |
| [mcp-cloud.md](mcp-cloud.md) | The local sync endpoint: proxy wiring, guarded initialization, the injection write path, state layout, wire contract |
| [testing-conflict-runbook.md](testing-conflict-runbook.md) | Manual runbook for the sync-conflict rounds — the one write-path leg that needs a human in front of the app (everything else is automated behind `MLO_LIVE=1`) |
| [agents/](agents/) | Conventions for AI agent skills: issue tracker, triage labels, domain-doc consumer rules (glossary/entry point: [/CONTEXT.md](../CONTEXT.md)) |
| [adr/](adr/) | Architecture decision records — decisions made since this index was written ([ADR-0001](adr/0001-distribution-surfaces.md): distribution surfaces; [ADR-0002](adr/0002-report-binding-mismatch-never-repair-it.md): report a binding mismatch, never repair it; [ADR-0003](adr/0003-resident-endpoint.md): the endpoint is a resident process; [ADR-0004](adr/0004-ground-truth-the-open-profile.md): ground-truth the open profile against the running app (superseded by ADR-0006); [ADR-0005](adr/0005-layered-rearchitecture-local-landing-writes.md): the layered rearchitecture with local-landing writes, whose [target-architecture spec](adr/0005-target-architecture-spec.md) is the contract the current code implements; [ADR-0006](adr/0006-detect-the-open-profile-from-the-process-alone.md): detect the open profile from the running process alone; [ADR-0007](adr/0007-recover-from-sync-drift-automatically.md): recover from identity drift automatically, reversing ADR-0002) |

The **canonical usage guide for the tools is not in this directory**: it is the MCP `instructions` string in [`mcp-server/src/server.ts`](../mcp-server/src/server.ts), which every client receives at connection time, plus the per-tool descriptions and schemas (`pnpm tools`). `tools.md` describes the surface for a human reader; `instructions` is what an agent is actually told, and it is the copy to change first.

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

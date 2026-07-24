# ADR-0001: Distribution surfaces — the protocol first, the Claude plugin as a convenience

Status: accepted (2026-07-25)

## Context

`mlo-mcp` ships as a Claude Code plugin (`.claude-plugin/plugin.json` + `marketplace.json`). That was chosen as the most mainstream packaging route available at the time, not as a decision to be Claude-only — but nothing recorded the intent, so the repo *looks* Claude-first to a reader.

Three surfaces can carry a server's usage contract to a client:

- **MCP `instructions`** (`InitializeResult.instructions`) — a standard optional protocol field, delivered to every client at connection time, no installation required.
- **Tool descriptions and input schemas** — delivered the same way, and the only surface some clients ever render (a tool-picker UI, a smaller model, a harness that summarises schemas without showing `instructions`).
- **Harness-specific packaging** — a Claude Code plugin, and the `skills` array such a plugin can declare.

Two pressures made the absence of a recorded decision costly:

1. A plausible-looking wrong turn is permanently available: adding a `skills` array to the plugin manifest to ship GTD guidance next to the server. That would be Claude-only, and it would duplicate what the protocol already delivers to everyone.
2. The [official MCP Registry](https://github.com/modelcontextprotocol/registry) is the one cross-client way to publish and version an MCP server, and `mlo-mcp` is absent from it.

## Decision

**The protocol is the primary surface.** `instructions` plus the tool descriptions and schemas are the canonical carrier of usage guidance. They reach every client with no installation, so nothing moves out of them into harness-specific packaging.

**Schemas stand alone.** Every input field naming a task reference says which kind it takes — a stable **GUID** (pointing at `get_task`) or a positional **Path id** (carrying `PATH_ID_CAVEAT` from `tools/shared.ts`, so the wording cannot drift between tools). A client that reads only schemas is then correct without `instructions` ever being surfaced. This is enforced as a class over the whole registry by `mcp-server/test/unit/tool-catalog.test.ts`, not field by field.

**`.claude-plugin/` stays, explicitly secondary, and is not extended.** It keeps working exactly as it does today. Specifically: no `skills` array, and no GTD methodology of any kind shipped from this repo. The server states mechanics; methodology lives in the workflow skills of the separate `gtd-skills` repo, which stay free of backend names so they can bind to other task backends.

**The cross-client install is `npx -y github:govza/mlo-mcp`** for any MCP client that speaks stdio, documented in the README ahead of the Claude-specific paths.

**The official MCP Registry is the intended publication path, and is deferred.** The registry only lists servers backed by a package in npm, PyPI, NuGet, OCI or MCPB; a GitHub-only `npx` install is not one of its supported package types, so there is no manifest we could publish today. When registry presence is wanted, the route is npm:

1. Publish `mlo-mcp` to npm (the name was unclaimed as of 2026-07-25; the root manifest's `bin`/`files` already point at the committed single-file bundle).
2. Add `"mcpName": "io.github.govza/mlo-mcp"` to the root `package.json` — this is how the registry verifies package ownership.
3. Commit a `server.json` (`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`) with a `registryType: "npm"` package entry.
4. Publish from a tag-triggered workflow with `mcp-publisher` and GitHub OIDC (`id-token: write`, no stored secret), so the registry version tracks releases instead of rotting as a manual step.

Until that happens the gap is recorded here rather than papered over with a `server.json` that cannot be published — which would only add a fourth copy of the version to drift.

## Options not taken

- **MCP prompts.** If server-shipped workflow text is ever genuinely wanted, `prompts` is the harness-neutral carrier and the right choice. Named here so a future reader reaches for it rather than a plugin skill.
- **A `skills` array in the plugin manifest.** Claude-only, and duplicates guidance the protocol already delivers everywhere.
- **An MCPB bundle on GitHub Releases** to reach the registry without npm. It avoids an npm account, but it means new bundling machinery and MCPB leans Claude-Desktop-specific — more harness coupling, not less.
- **Per-harness packaging** for other clients' bespoke plugin formats, should any appear.

## Consequences

- Guidance has exactly one home, so it cannot drift between `instructions` and a shipped skill.
- A contributor tempted to deepen the Claude coupling has a written reason not to.
- Discovery through the registry stays unavailable until the npm step is taken. That is a known, recorded gap with a written recipe — not an oversight.
- The schema-completeness rule is a standing obligation: a new tool with an undocumented GUID or Path id field fails `pnpm test:unit` rather than shipping. This repo has no CI yet, so that check — like the version-consistency one — is only as reliable as running the suite before a release.

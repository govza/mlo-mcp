# Domain context: mlo-mcp

Ubiquitous language for this repo. Terms are defined here in one or two lines; the deep definitions live in the reference docs under [docs/](docs/README.md) — follow the links rather than re-deriving behavior. When writing issue titles, test names, or proposals, use these terms exactly.

## The app and its data

- **MLO** — MyLifeOrganized, the Windows desktop outliner this server drives via `mlo.exe`'s command line ([docs/mlo/mlo-cli.md](docs/mlo/mlo-cli.md)).
- **Profile / `.ml` data file** — MLO's single binary data file. Auto-detected from the registry's `LastDBFile` (the profile the app has open); the server never rewrites it.
- **Task tree** — one deep outline; deep nesting is idiomatic. The task model (computed-score priority, contexts, dependencies, visibility) is in [docs/mlo/mlo-task-model.md](docs/mlo/mlo-task-model.md).
- **Context (MLO "Place")** — `@Office`-style GTD context attached to tasks.
- **Path id** — positional id like `"1.2.3"`; shifts whenever the tree changes, valid only for immediate follow-up calls. Never stored.
- **GUID / UID** — a task's stable identity, resolved by structural alignment of a fresh export against the bootstrapped cloud tree ([docs/tools.md](docs/tools.md) → Shared semantics).
- **dataFileUID** — a profile's sync identity; keys all cloud-side state.

## The sync data plane

- **mcp-cloud / the endpoint** — the server's loopback HTTP sync endpoint (`127.0.0.1:8181`) that MLO reaches through its proxy setting ([docs/mcp-cloud.md](docs/mcp-cloud.md)).
- **Upstream mode** — the only real-profile architecture: `MLO ↔ mcp-cloud ↔ vendor Cloud`. The endpoint is a transparent proxy for MLO's own sessions and one more sync client for MCP reads/writes.
- **Local mode** — the endpoint as a replacement cloud, dev/test profiles only (`scripts/bootstrap-local.ts`). Switching a profile between sync authorities is unrecoverable ([docs/mlo/cloud-sync.md](docs/mlo/cloud-sync.md)).
- **Delta / envelope** — the sync unit: a ZIP/`data.csv` carrying complete 82-column task rows ([docs/mlo/cloud-sync.md](docs/mlo/cloud-sync.md)).
- **Mirror** — the passive per-`dataFileUID` capture of validated vendor envelopes, ordered by vendor-assigned versions.
- **Partition** — the per-`dataFileUID` state directory under the private state root; lifecycle `uninitialized → bootstrap-required → ready`.
- **Bootstrap** — the one-time pull of the vendor cloud's complete history that binds a profile and enables writes (`cloud_bootstrap`).
- **QuickSync** — `mlo.exe -QuickSync`; how queued deltas reach the running app. Every write follows **queue → QuickSync → verify**.
- **Verified flag** — advisory: `verified: true` means a fresh post-QuickSync export confirmed the change; `false` means durably queued, not failed.
- **Tombstone** — a deletion record in a delta; `delete_task` tombstones a task and its whole subtree.

## Where the deep docs are

[docs/README.md](docs/README.md) is the index: server internals in [docs/server-architecture.md](docs/server-architecture.md), tool semantics in [docs/tools.md](docs/tools.md), the sync endpoint in [docs/mcp-cloud.md](docs/mcp-cloud.md), and the reverse-engineered MLO formats/protocol under [docs/mlo/](docs/mlo/). Established design decisions are currently recorded in prose in those docs; new decisions get ADRs under `docs/adr/` (see [docs/agents/domain.md](docs/agents/domain.md)).

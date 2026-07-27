# Domain context: mlo-mcp

Ubiquitous language for this repo. Terms are defined here in one or two lines; the deep definitions live in the reference docs under [docs/](docs/README.md) — follow the links rather than re-deriving behavior. When writing issue titles, test names, or proposals, use these terms exactly.

## The app and its data

- **MLO** — MyLifeOrganized, the Windows desktop outliner this server drives via `mlo.exe`'s command line ([docs/mlo/mlo-cli.md](docs/mlo/mlo-cli.md)).
- **Profile / `.ml` data file** — MLO's single binary data file. Auto-detected, never configured; the server never rewrites it.
- **Profile candidate** — the path the registry's `LastDBFile` proposes. A proposal only: MLO writes that value when it *exits*, so it goes stale on an in-app profile switch ([ADR-0004](docs/adr/0004-ground-truth-the-open-profile.md)).
- **Refute (a candidate)** — what the running app's own evidence does to a stale candidate: a window title naming a different profile, or the candidate file being one MLO does not hold open. An *unavailable* signal never refutes.
- **Profile verdict** — detection's answer: the accepted data file, or a refusal (`profile-switched` / `no-profile`). A refuted candidate refuses; it is never silently replaced with a guess.
- **Task tree** — one deep outline; deep nesting is idiomatic. The task model (computed-score priority, contexts, dependencies, visibility) is in [docs/mlo/mlo-task-model.md](docs/mlo/mlo-task-model.md).
- **Context (MLO "Place")** — `@Office`-style GTD context attached to tasks. Hierarchical (a context *includes* narrower ones) and optionally open only during declared hours.
- **To-Do list** — the flattened, ranked action list derived from the task tree; only tasks with no uncompleted children appear ([docs/mlo/mlo-task-model.md](docs/mlo/mlo-task-model.md) §1).
- **Next action** — a task the To-Do list would offer: a leaf that no flag, ordering rule, dependency, start date, or closed context is holding back.
- **Available / deferred** — the two states of a To-Do-list task: actionable now, versus a real action that something defers (a dependency, a start date, a closed context).
- **Container** — a task the outline declares as a grouping: a **project** (`IsProject`) or a **folder** (MLO's Folder flag — a bucket that never appears in the To-Do list itself, even once everything under it is done).
- **Path id** — positional id like `"1.2.3"`; shifts whenever the tree changes, valid only for immediate follow-up calls. Never stored.
- **GUID / UID** — a task's stable identity, resolved by structural alignment of a fresh export against the bootstrapped cloud tree ([docs/tools.md](docs/tools.md) → Shared semantics).
- **dataFileUID** — a profile's sync identity; keys all cloud-side state.
- **Binding** — the persisted profile → `dataFileUID` pointer, attached only by an explicit bootstrap.
- **Unbound sighting** — a `dataFileUID` seen syncing through the endpoint with no binding; recorded because the authority decision is the only place that learns the identity MLO actually syncs.
- **Binding mismatch** — a bound profile syncing under a different identity: writes would queue into a partition the app never reads, so they are refused ([ADR-0002](docs/adr/0002-report-binding-mismatch-never-repair-it.md)).

## The sync data plane

- **mcp-cloud / the endpoint** — the server's loopback HTTP sync endpoint (`127.0.0.1:8181`) that MLO reaches through its proxy setting ([docs/mcp-cloud.md](docs/mcp-cloud.md)).
- **Resident endpoint** — the long-lived process that owns the loopback listener and outlives every MCP session, auto-spawned by the first session that finds the port free ([ADR-0003](docs/adr/0003-resident-endpoint.md)). Started by re-invoking the server's own entry point with `--serve-cloud`.
- **Attached session** — an MCP server process. Every one of them attaches to the resident endpoint and none ever listens, so which client you are in never decides what works.
- **Credential-lending seam** — the only three things an attached session asks the resident for, because they need the vendor contact: refresh a mirror, commit a delta, pull a full history. Everything else runs in the session against the shared state root; the resident executes no tools.
- **Stale-write refusal** — a commit refused because the mirror moved between refresh and commit: the authored rows are superseded, so nothing is uploaded and a retry re-authors from the current ones.
- **Unadvanced commit** — a vendor upload answered `Result=true` whose `newServerTimeStamp` does not advance past the mirror high-water: the vendor stored nothing any sync client will ever pull, so the write is refused and dead-lettered — never reported as queued. Cursor advancement, not `Result=true`, is the only accepted proof of storage.
- **Upstream mode** — the only real-profile architecture: `MLO ↔ mcp-cloud ↔ vendor Cloud`. The endpoint is a transparent proxy for MLO's own sessions and one more sync client for MCP reads/writes.
- **Vendor contact** — a profile's own cloud credentials, scraped from its proxied sync traffic and held strictly in memory, never persisted. What lets the endpoint act as one more sync client, and the only state a second process cannot recover from disk.
- **Local mode** — the endpoint as a replacement cloud, dev/test profiles only (`scripts/bootstrap-local.ts`). Switching a profile between sync authorities is unrecoverable ([docs/mlo/cloud-sync.md](docs/mlo/cloud-sync.md)).
- **Delta / envelope** — the sync unit: a ZIP/`data.csv` carrying complete 82-column task rows ([docs/mlo/cloud-sync.md](docs/mlo/cloud-sync.md)).
- **Mirror** — the passive per-`dataFileUID` capture of validated vendor envelopes, ordered by vendor-assigned versions.
- **Partition** — the per-`dataFileUID` state directory under the private state root; lifecycle `uninitialized → bootstrap-required → ready`.
- **Bootstrap** — the one-time pull of the vendor cloud's complete history that binds a profile and enables writes (`cloud_bootstrap`).
- **QuickSync** — `mlo.exe -QuickSync`; a best-effort accelerator fired after every accept, never load-bearing. MLO's own ~90 s sync cadence is what delivers a write ([ADR-0005](docs/adr/0005-target-architecture-spec.md) §2).
- **Accept receipt / `writeId`** — what a write tool answers with, at durable accept: the queue holds the rows, MLO has not applied them. Keyed by `writeId`, not uid, because two queued writes can share one uid.
- **Write status** — the five states an accept receipt passes through, read back through `write_status`: `accepted | delivered | verified | expired | superseded`. `verified` is an advisory export re-align on top of `delivered`; it is no longer a boolean on a write's own answer.
- **Read-your-own-writes overlay** — the pending queue composed onto a fresh export at read time, so a caller sees its own accepted writes immediately (`pending: true` + the `writeId`). Derived, never stored: when a write leaves the queue (or its TTL passes) the entry drops silently and reads revert to export truth — loudness lives in `write_status` / `cloud_status`.
- **Tombstone** — a deletion record in a delta; `delete_task` tombstones a task and its whole subtree.
- **Dead letter** — the raw text of a write the server refused, appended to a file in the state root so the words survive a failure that queued nothing. Never replayed automatically.

## Failures

- **Failure kind** — the tagged name a refusal travels under (`unknown-row`, `binding-conflict`, …). Every kind this build can produce is declared once in `mcp-server/src/error-contract.ts` with its tier, its `retryable`, and what ends it ([ADR-0005](docs/adr/0005-target-architecture-spec.md) §6).
- **Failures as values** — a refusal crosses every boundary as a `ServiceResult` (`{ isErrored, value | failure }`), never as a throw. Exceptions are reserved for genuine invariant violations, such as a repository wired without a write driver.
- **Blast radius** — how far one failure reaches. Exactly four tiers: **event** (journaled, blocks nothing), **op refusal** (this call refuses, the next is fresh), **write-gate refusal** (every write refuses the same way until a state changes; reads untouched), **startup verdict** (refuse to start, exit 1 — allowed before serving only). Post-startup, nothing stops the server.
- **Remedy** — the concrete thing that ends a refusal, declared by the producer and carried with the kind. Caller metadata: nothing in this server ever retries automatically.
- **Advisory** — an event-tier observation riding along with a result that still succeeded; never a refusal.
- **Degraded to `unknown`** — a problem+json `type` an older session does not recognize, rehydrated with its wire type, title and extension members intact. Degraded, never lost, and never thrown.

## Where the deep docs are

[docs/README.md](docs/README.md) is the index: server internals in [docs/server-architecture.md](docs/server-architecture.md), tool semantics in [docs/tools.md](docs/tools.md), the sync endpoint in [docs/mcp-cloud.md](docs/mcp-cloud.md), and the reverse-engineered MLO formats/protocol under [docs/mlo/](docs/mlo/). Established design decisions are currently recorded in prose in those docs; new decisions get ADRs under `docs/adr/` (see [docs/agents/domain.md](docs/agents/domain.md)).

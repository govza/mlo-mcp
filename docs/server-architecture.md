# mlo-mcp server architecture

TypeScript MCP server (`mcp-server/`) over stdio. Node 22, pnpm, ESM, strict TS; `@modelcontextprotocol/sdk` + `fast-xml-parser` + `zod`. Model types keep MLO's original Delphi PascalCase field names.

Reads come from `mlo.exe`'s XML export. Writes land in the local sync endpoint
specified in [mcp-cloud.md](mcp-cloud.md) and reach the profile through MLO's
own sync session — the server never rewrites the `.ml` data file. What each tool
is for is defined in [tools.md](tools.md); this document covers the internals.

## Layers

The architecture and its rules are [ADR-0005](adr/0005-layered-rearchitecture-local-landing-writes.md)
and its [target-architecture spec](adr/0005-target-architecture-spec.md):

```text
tools (controllers)     schema validation + one service call, nothing else
  |
services                domain rules; GTD-intent slicing; ServiceResult out
  |
repositories            the only code touching mlo.exe, the state root,
  |                     or the resident process
drivers (internal)      named seams inside repository impls (MloCli, ResidentClient)

domain model            pure functions/types importable by any layer
composition root        wiring, process infra (spawn/skew/shutdown/watchers)
```

- Calls run strictly downward. Services never call each other; the one shared
  computation is the internal `AvailabilityEngine`.
- `ToolContext` is **required services only** — `{ outline, nextActions, review,
  admin, config, log }`. No repositories, no optional fields: the historic
  "cloud absent, silently downgrade" branch is unrepresentable. Repositories are
  wired into services once, at the composition root.
- No service ever learns that a resident process exists.

## Module map

```
src/
  index.ts          composition root: wires drivers -> repositories -> services,
                    connects the stdio transport, and re-invokes itself with
                    --serve-cloud as the resident endpoint. Idle-exit watchers
                    (rebuilt bundle, profile switch, binding appeared for a
                    session that composed unbound — binding-watch.ts) make the
                    client respawn a current server on the next tool call
  server.ts         the protocol surface — identity (version.ts), the
                    connection-time instructions string, tool registration from
                    tools/registry.ts; separate from index.ts so a test can
                    connect a real client in memory
  config.ts         MloConfig + CloudConfig (data file: auto-detected via
                    profile-detect.ts or refuse to start, so MLO must be
                    running; --data-file= pins it for the test harness only,
                    which runs with the GUI closed; env: MLO_EXE_PATH,
                    MLO_EXPORT_DIR, MLO_CACHE_STALE_MS, MLO_INBOX_CAPTION,
                    MLO_CLOUD_HOST/PORT/STATE_ROOT, MLO_WRITE_TTL_MINUTES)
  context.ts        ToolContext construction — the required-services struct
  error-contract.ts the four-tier failure table AS DATA, plus the per-boundary
                    unions derived from it (see below)
  result.ts         ServiceResult carrier: ok/failed, advisories
  profile-detect.ts which profile MLO actually has open, asking the running
                    process and nothing it saved for next time: each mlo.exe's
                    own pid-tagged block in MLO's log names the profile that run
                    opened, corroborated by the window title and by MLO's hold on
                    the file, and a contradiction is a refusal to start
                    (ADR-0006). One PowerShell round trip gathers the
                    observation; judgeProfile() is the pure policy over it
  tools/*.ts        one declarative MloTool per file; contract.ts = defineTool /
                    registerTool / guard (controller infra); registry.ts = the
                    authoritative tool list
  services/         outline.ts (all writes) + outline-authoring.ts (row/patch
                    authoring), next-actions.ts, review.ts, availability.ts
                    (internal engine), identity.ts (one owner of "which row is
                    this id"), admin.ts (the cloud plane), failures.ts
  repo/             mlo-repository.ts (the interface: snapshot/write/status),
                    local-mlo-repository.ts (impl), pending-overlay.ts
                    (read-your-own-writes composition), and the two drivers:
                    mlo-cli.ts, resident-client.ts
  cloud/            the resident endpoint and the partition state it owns:
                    server.ts (SOAP proxy + /v1), gateway.ts (authority
                    decision, bindings, contacts), write-path.ts (queue,
                    injection, GetFileTS nudge, Apply observation, TTL),
                    auto-init.ts (guarded initialization), partition.ts +
                    row-store / capture-journal / injection-queue /
                    write-outcomes / binding / sightings / dead-letter,
                    upstream.ts (forward half + the one guarded vendor pull),
                    soap.ts, capture.ts, sync-observer.ts, problem.ts,
                    atomic-file.ts, state-lock.ts, profile-backup.ts
                    — see mcp-cloud.md
  domain model      mlo-schema.ts (section headers, the 82-column TodoItems
                    contract, row authoring), guid.ts, delta-merge.ts, csv.ts,
                    envelope.ts, cursor.ts (all under cloud/); task-tree.ts,
                    task-summary.ts, xml.ts, places.ts, guids.ts
scripts/
  run-tool.ts       invoke any tool directly, no MCP client: `pnpm tool <name> '<json>'`
  tool-catalog.ts   registry → readable catalog, typed from the zod schemas
  tools.ts          browse it: `pnpm tools [<name>|--json]` (no MLO, no data file)
  serve-cloud.ts    run the resident endpoint in the FOREGROUND for debugging
                    (sessions normally start it themselves: `index.js --serve-cloud`)
```

Tools are declarative objects (`defineTool` in `tools/contract.ts`: name, schemas,
all four MCP annotation hints, `execute(args, ctx)`) — callable without a server,
which is what `scripts/run-tool.ts` uses. Batch-capable write tools send the
whole batch (`ids`/`updates` arrays) as ONE delta; batches are atomic (any bad id
refuses before anything is queued).

## Concurrency: two locks

1. **In-process**: a promise-chain mutex serializes every mlo.exe invocation within one server.
2. **Cross-process**: a lock *directory* next to the data file (`<file>.mcp-lock`, atomic `mkdir`, stale-broken after 3 min, 90 s acquisition deadline) serializes invocations across multiple server processes — one per Claude session. Reentrant within a process via a held-flag.

Why: MLO invocations racing each other trigger a modal "file is locked by another process" dialog and hang forever.

Both live in the `MloCli` driver, as module-level singletons — process-wide by
nature, not per-instance. The state root has its own cross-process lock
(`cloud/state-lock.ts`) for the files several sessions write.

No session binds the endpoint's port (8181 installed, 8282 from a source
checkout — see `mcp-server/README.md`): the listener is a separate
long-lived process, started detached by the first session that finds the port
free ([ADR-0003](adr/0003-resident-endpoint.md)), attached to by every session
on every path.

## Reads

`LocalMloRepository.snapshot()` is the one read: XML export → parsed doc →
`TaskNode` tree → GUIDs annotated from the `.ml` binary, cached for
`MLO_CACHE_STALE_MS` (default 30 s) and composed with the pending-write overlay
at read time (`repo/pending-overlay.ts`). Every service sees the same picture,
so read-your-own-writes needs no per-tool opt-in: an add appears as a phantom
row, an update merged, a completion completed, a delete hidden, each carrying
`pending: true` and its `writeId`. The overlay is derived, never stored — it
self-empties as the queue drains, and an expired or superseded entry simply
disappears (the loudness lives in `write_status` / `cloud_status`).

Ids are path-based (`1.2.3` = position, root excluded) and shift when the tree
changes — tools tell agents to re-list before mutating. `IdentityService` is the
one owner of "which row is this id": one resolver per snapshot, aligning the
export and its binary-recovered GUIDs against the **row store**, reporting
`confirmed` when the store holds that UID's full row and `unconfirmed` when only
the binary recovered it.

Read services on top: `NextActionsService` (Engage — the To-Do list MLO would
show), `ReviewService` (Reflect — review-due, stalled projects, waiting-for,
hygiene), both over the internal `AvailabilityEngine` (leaf rule, Folder/Hide
flags, complete-in-order, dependency blocking, start dates, context hours,
computed score).

## Writes: author, accept, ride MLO's sync

`OutlineService` authors complete 82-column rows — adds from scratch,
update/complete from the row store's latest captured row, delete as a tombstone
— and calls `MloRepository.write(rows)`, which resolves once the rows are
fsync'd into the resident's injection queue. **That is the whole synchronous
part**: the tool returns `{ uid, writeId, status: "accepted", expiresAt }` and
nothing waits. The resident injects the rows into MLO's next forwarded sync
session, observes MLO's own Apply to call them `delivered` (content compare, not
UID alone), and expires them at TTL if no session ever carries them
([mcp-cloud.md](mcp-cloud.md) has the mechanics). There is no post-write
QuickSync-and-diff and no `verified` boolean; `write_status(writeId)` is where
an outcome lives.

The MLO app keeps running throughout and nothing touches the `.ml` file
directly. Still: **back up the profile before first use** — sync flows rewrite
sync state inside the `.ml`.

## Error handling & safety conventions

- **One carrier.** `ServiceResult<T, F>` — `{ isErrored: false, value, advisories? }`
  or `{ isErrored: true, failure }`, plain tagged objects (class identity dies at
  the HTTP seam). One closed union per boundary: repositories return infra kinds,
  services map them into domain kinds and forward infra kinds under their own
  names, and the tool layer is the only place a failure becomes prose — once, as
  `detail — remedy [kind]`. Genuine invariant violations stay exceptions.
- **The four-tier table is data** (`src/error-contract.ts`): one row per kind
  with its tier (Event / op refusal / write-gate refusal / startup verdict),
  `retryable`, meaning, and the observation that ends it. The boundary unions are
  derived from the table, so a union and the table cannot drift, and the review
  gates run as tests (`test/unit/error-contract.test.ts`). Post-startup, no
  failure stops the server.
- **Across the process seam**, refusals are RFC 9457 problem+json and rehydrate
  into failures; an unknown `type` degrades to `{ kind: "unknown", ... }` rather
  than throwing (`wireType` and the problem's extension members survive onto the
  failure).
- **No automatic retries anywhere.** `retryable`/`remedy` are producer-declared
  caller metadata. Lazy attach-and-spawn removed the whole "restart the client"
  remedy class.
- **Dead letter.** A refused write records its text, the tool, the reason and a
  timestamp in `dead-letters.json` in the state root, and the refusal names that
  path. Bounded both ways (oldest evicted past 50 entries, one entry's text
  capped), **never replayed** and never makes a refused write report success:
  replaying on top of a refusal reinvents [ADR-0002](adr/0002-report-binding-mismatch-never-repair-it.md)'s
  failure mode. Recovery is reading the file by hand.
- Tools return `{isError, content}` with actionable messages, never throw to the
  transport; stderr-only logging (stdout is JSON-RPC).
- Annotations: `readOnlyHint` on list/search/get/status, `destructiveHint` on
  complete/update/delete, `idempotentHint` on sync, `openWorldHint` on every tool
  that can reach the vendor through MLO. All tools return `structuredContent`
  matching an `outputSchema`.

## Tests (vitest, two projects)

- **unit** — the domain model (CSV/envelope codecs, delta schema and merge, tree
  ids and filters against a real export fixture), the services, the resident's
  HTTP surface and write path, profile detection, and the error-contract gates.
  Two suites earn their own mention:
  - the **sabotage suite** instantiates the resident's handler stack in-process,
    feeds it a canned vendor session, and fault-injects capture, the row store,
    the queue, the binding and every service in turn, asserting the proxied sync
    still completes with the vendor's payload intact — the non-interference
    invariant, executable;
  - the **auto-init suite** fault-injects each pull stage (pull, validate,
    ground-truth) and asserts no binding is written on any partial failure.
  One suite is the exception to "no live machine": `profile-detect`'s
  probe-contract block runs the real PowerShell probe, because the seams it pins
  (the script's JSON shape, and the log lines it selects being lines the parser
  understands) have no other test. It is Windows-gated and read-only, needs no
  mlo.exe, and so runs with the GUI open.
- **mlo** (serial, slow) — real `mlo.exe` against a temp copy of the test
  profile: export, exit codes, GUID recovery; plus the stdio E2E (tool
  listing/annotations, instructions, read tools, `cloud_status`). **GUI must be
  closed** (guarded with a clear failure message).
- **Contract suites** (`test/contract/`) are one shared parameterized suite per
  interface, run against the fakes in `unit` — typed refusal kinds and the
  problem+json shape included, so a fake cannot drift from the real
  implementation.
- **Fakes** (`test/fakes/`, never shipped in `src/`): `FakeMloCli` (scriptable
  exit codes, both live CLI traps), `FakeResidentClient` (problem+json refusals
  by kind, incl. unknown), `FakeMloRepository` (in-memory tree plus a
  hand-driven `transition(writeId, status)` over the five states, which is how
  the conflict-skip and stalled-session outcomes are exercised without a
  resident), plus row store, capture journal and state-store fakes.
- **Live legs** behind `MLO_LIVE=1` (`test/mlo/live-write.test.ts`): the
  `GetFileTS` nudge, verbatim answers once the queue empties, four-verb
  propagation, TTL expiry. They mutate the profile they are pointed at and take
  minutes. The conflict rounds stay a manual runbook:
  [testing-conflict-runbook.md](testing-conflict-runbook.md).

# mlo-mcp server architecture

TypeScript MCP server (`mcp-server/`) over stdio. Node 22, pnpm, ESM, strict TS; `@modelcontextprotocol/sdk` + `fast-xml-parser` + `zod`. Model types keep MLO's original Delphi PascalCase field names.

All writes flow through the local cloud-sync endpoint specified in
[mcp-cloud.md](mcp-cloud.md) — the server never rewrites the `.ml` data file.
What each tool is for is defined in [tools.md](tools.md); this document covers
the server internals around that loop.

## Module map

```
src/
  index.ts          McpServer wiring (registers tools/registry.ts, server
                    instructions string), stdio transport, starts the cloud endpoint
  config.ts         env config (MLO_DATA_FILE, defaulting to profile/profile.ml in repo
                    checkouts; MLO_EXE_PATH, MLO_EXPORT_DIR, MLO_CACHE_STALE_MS,
                    MLO_CLOUD_HOST/PORT; the partitioned state root is automatic)
  mlo-cli.ts        mlo.exe invocation: Delphi quoting, timeouts, exit-code mapping,
                    both locks, -saveXML export, -QuickSync
  xml.ts            parse/build (fast-xml-parser), RawTaskNode
  task-tree.ts      RawTaskNode → TaskNode model, path ids, find/flatten/search/render
  guids.ts          Caption→GUID recovery from the .ml binary (cross-check only;
                    see mlo/ml-binary-format.md)
  store.ts          cached snapshot: export → parse → tree → GUID annotation
  cloud/            the cloud endpoint (gateway + per-dataFileUID partitions and
                    bindings, vendor proxy + mirror + vendor client sessions
                    (upstream.ts), bootstrap window, snapshot store/validation,
                    structural identity (structure-align.ts), SOAP adapter, delta
                    log/state, CSV/envelope codecs, log-projection) — see mcp-cloud.md
  tools/*.ts        one declarative MloTool per file (shared.ts: contract +
                    registerTool; registry.ts: the authoritative tool list;
                    row-update.ts: shared queue→QuickSync→verify runner for the
                    full-row edit tools)
scripts/
  run-tool.ts       invoke any tool directly, no MCP client: `pnpm tool <name> '<json>'`
  tool-catalog.ts   registry → readable catalog, typed from the zod schemas
  tools.ts          browse it: `pnpm tools [<name>|--json]` (no MLO, no data file)
  cloud-client.ts   app-side cloud client CLI: `pnpm cloud pull/push/finalize/sync`
  serve-cloud.ts    run the cloud endpoint standalone (no MCP client attached)
  bootstrap-local.ts DEV ONLY: arm a local-mode (replacement-server) bootstrap window
```

Tools are declarative objects (`defineTool` in `tools/shared.ts`: name, schemas, all four
MCP annotation hints, `execute(args, ctx)`) — callable without a server, which is what
`scripts/run-tool.ts` uses. Batch-capable write tools send the whole batch (`ids`/`updates`
arrays) as ONE delta; batches are atomic (any bad id aborts before anything is queued).

## Concurrency: two locks

1. **In-process**: a promise-chain mutex serializes every mlo.exe invocation within one server.
2. **Cross-process**: a lock *directory* next to the data file (`<file>.ml.mcp-lock`, atomic `mkdir`, stale-broken after 3 min) serializes invocations across multiple server processes — one per Claude session. Reentrant within a process via a held-flag. (The cloud delta log has its own lock directory in the state dir — see mcp-cloud.md.)

Only the first session binds the cloud endpoint's port (default 8181); later sessions detect a healthy mlo-mcp endpoint there and attach — they run no listener and share the delta log through the state-dir lock.

Why: MLO invocations racing each other trigger a modal "file is locked by another process" dialog and hang forever.

## Reads

`store.ts` keeps a snapshot (XML export → parsed doc → TaskNode tree → GUIDs annotated from the binary) cached for `MLO_CACHE_STALE_MS` (default 30 s). Every write invalidates it. Ids are path-based (`1.2.3` = position, root excluded) and shift when the tree changes — tools tell agents to re-list before mutating.

## Writes: queue → QuickSync → verify

Write tools resolve a write channel (`requireWriteChannel`): normally the
delta (a full task row, or tombstones) is committed to the real vendor Cloud
in the endpoint's own sync session and MLO receives it on the triggered
`mlo.exe -QuickSync`; local-mode test partitions append to the replacement
log instead. A fresh export then checks whether MLO applied it. The
`verified` flag in every write result reports that check; `false` means
*accepted, not yet applied* — MLO merges it on a later sync session. The MLO
app keeps running throughout and nothing touches the `.ml` file directly.
Still: **back up the profile before the first bootstrap** — sync flows
rewrite sync state inside the `.ml`.

Full-row edits (`update_task`, `complete_task`, `uncomplete_task`) source the
82-column record from the bootstrapped baseline + later deltas via
`cloud/log-projection.ts` and share the runner in `tools/row-update.ts`; see
mcp-cloud.md for why the XML export cannot be that source.

## Error handling & safety conventions

- Tools return `{isError, content}` with actionable messages, never throw to the transport; stderr-only logging (stdout is JSON-RPC).
- Annotations: `readOnlyHint` on list/search/get/status, `destructiveHint` on complete/update/delete, `idempotentHint` on sync, `openWorldHint` on every tool that triggers a sync session. All tools return `structuredContent` matching an `outputSchema`.

## Tests (vitest, 3 projects-in-2)

- **unit** — parser/builder round-trip, tree ids, filters (fixture is a real export); the whole cloud protocol layer (CSV/envelope codecs, delta building/merging, log state and projection, HTTP server, SOAP adapter, tool helpers).
- **mlo** (serial, slow) — real mlo.exe against a temp copy of the test profile: export, exit codes, GUID recovery.
- **e2e** (inside mlo project) — real MCP client over stdio: tool listing/annotations, instructions, read tools, cloud_status. Write tools need the app's sync proxy wired to the local endpoint and are exercised outside this headless suite.

GUI must be closed for the mlo project (guarded with a clear failure message).

# mcp-cloud: the local cloud-sync endpoint for the MLO app

`mcp-cloud` is the server's cloud-side half: a loopback HTTP listener on
`127.0.0.1:8181` that MLO's cloud-sync client reaches through the app's HTTP
**proxy setting** (MLO hardcodes the vendor sync URL; the proxy is the
permanent wiring, not a debugging aid). Sync sessions are triggered with the
already-verified `mlo.exe -QuickSync`.

It operates in one of two **modes per profile**, chosen by the profile's
persisted binding. The two modes never share state, because each sync endpoint
owns its own remote-version namespace and switching a profile between
authorities is unrecoverable (verified live: duplicate-subtree imports, then
foreign-cursor rejections — see
[Switching endpoints is not a reconnect](mlo/cloud-sync.md#switching-endpoints-is-not-a-reconnect)).

## Upstream mode — real profiles (default)

The endpoint is a **transparent proxy** for the three vendor sync operations.
The vendor Cloud remains the only cursor authority: requests and responses
pass through byte-for-byte, all three operations of one `sessionID` go to the
same authority, and nothing local generates, rebases, or adopts a cursor.

Passively, the endpoint captures the validated envelopes flowing through into
a per-`dataFileUID` **mirror**, ordered by the vendor-assigned versions
(uploads at `newServerTimeStamp`, downloads at `maxVersion`). A capture
failure never alters the proxied exchange; it only marks the mirror unhealthy
in `cloud_status`.

- **Bootstrap:** arm with `cloud_bootstrap`, then run **Re-synchronize** in
  MLO against the real Cloud through the proxy. The full database flowing
  through (in either direction) is validated and materialized as the mirror
  baseline; the profile's `dataFileUID` is bound and the partition becomes
  `ready`. Reads and identity resolution then work for every task while MLO,
  the vendor Cloud, and mobile clients stay in sync.
- **Writes:** refused ("upstream write-through not enabled"). Stage 2 —
  merging pending MCP deltas into MLO's own outbound Apply so the vendor
  assigns the real version — has its seam in `src/cloud/upstream.ts`
  (`UpstreamWriteThrough`, gated by `MLO_CLOUD_WRITE_THROUGH`), but stays
  disabled until the echo/replay/merged-row experiments in cloud-sync.md's
  open list are captured on a disposable vendor profile.
- **Operational precondition:** MLO's cloud login must have "Use secure
  connection" **unchecked**. A TLS `CONNECT` to the vendor sync host tunnels
  end-to-end, blinding the mirror; the endpoint records this and
  `cloud_status` reports `mirror.mirrorBlind: true`.

## Local mode — disposable/offline profiles

The original replacement-server behavior, hardened: the endpoint terminates
the three sync operations itself and owns the cursor namespace. A local-mode
profile must **never** sync against the vendor endpoint again; returning to
the vendor is a fresh full re-synchronization against an empty vendor file,
with a separate profile copy.

- The server keeps an **append-only delta log** per partition. Each entry is
  `{ cursor, origin, envelope }` (`origin` is `"mcp"` or `"app"`); pull
  returns only entries whose origin differs from the caller; cursors are
  signed 64-bit, strictly increasing, not necessarily contiguous.
- `ApplyModificationsBytesEx.lastSyncTimestamp` is an opaque signed 64-bit
  **LocalStamp** (`src/cloud/local-stamp.ts`): recorded for diagnostics, never
  compared against the cursor namespace, never a rejection reason. (The
  captured vendor counterexample: local 24838 against remote 15515,
  accepted.)
- Cursor adoption (bridging to the cursor a profile already stores) happens
  only into a genuinely uninitialized partition. A `ready` partition that
  receives a foreign/newer `newerThan` answers with an explicit SOAP-level
  **endpoint mismatch** failure — never an HTTP 500, never a silent rebase —
  and `cloud_status` counts it distinctly from `bootstrap-required`.

## Partitions, binding, lifecycle

All real-profile state lives under a private root **outside the checkout**
(default `%LOCALAPPDATA%\mlo-mcp\cloud`, restricted to the current user via a
best-effort `icacls` on creation):

```text
<stateRoot>/
  bindings.json                 profile path -> { mode, dataFileUID?, boundAt }
  soap-summary.jsonl            credential-safe structural traffic summaries
  bootstrap/armed.json          the persisted one-time bootstrap window (+ staged.zip)
  partitions/<key>/             key = sha256(normalized dataFileUID), first 16 hex
    meta.json                   { dataFileUID, mode, lifecycle, createdAt }
    local/                      local-mode delta log (state.json, delta-<cursor>.zip)
      snapshot/                 materialized baseline (snapshot-<n>.csv + pointer)
    mirror/                     upstream captures at vendor versions (+ its snapshot/)
    clients/                    scripts/cloud-client per-partition cursor files
```

Rules, all fail-closed:

- Every access path — SOAP, `/v1`, MCP tools, `cloud_status` — resolves the
  same partition through the gateway. Unknown `dataFileUID`s are refused
  locally (or, in proxy position, forwarded to the vendor **without capture**).
- A profile is never bound to "the last UID seen". The UID attaches only
  during an armed bootstrap window, which accepts exactly one previously
  unknown UID; a second unknown UID disarms the window. One UID serves one
  profile; a binding's mode never changes silently (`cloud_bootstrap
  { rebind: true }` starts a fresh partition and re-bootstraps; the old
  partition stays on disk as evidence).
- Partition lifecycle: `uninitialized` → `bootstrap-required` → `ready`.
  Mutation tools fail fast before queueing anything unless the partition is
  `ready` (local mode); their error directs to `cloud_bootstrap` +
  Re-synchronize, because an ordinary QuickSync cannot hydrate pre-existing
  tasks.

## Bootstrap (verified flow)

MLO's **Re-synchronize** shows a confirmation only and runs
`Get → Apply(full snapshot) → Get → Release`
([details](mlo/cloud-sync.md#re-synchronize)). With Bidirectional, no
exclusions, and an empty partition, MLO uploads its complete database — every
task as a complete 82-column row with its stable UID, possibly with historical
tombstones.

The endpoint detects bootstrap as **armed session + validated coverage**,
never a counter value. Validation requires the exact supported `TodoItems`
header and row width, valid unique UIDs, resolved acyclic parents, tombstones
disjoint from live rows, resolving context/flag/dependency/ordering
references, `FileVersion` 3, a `Config` section (the captured full-upload
marker), and verbatim preservation of unknown sections/columns/cells. A
passing snapshot is materialized transactionally (temp + fsync + pointer
rename) as the partition baseline; a failing upload is refused (MLO keeps its
baseline), the staged bytes are kept for diagnosis, and the partition stays
`bootstrap-required`.

Projections read **snapshot + newer log entries**, so identity and full-row
coverage come from the baseline instead of best-effort recovery. Path-id
resolution aligns the fresh XML outline structurally against the
UID/`ParentUID`/`ItemIndex` tree (duplicate sibling captions resolve by
position); the binary `.ml` GUID recovery and caption-path walk are
cross-checks only.

## Wire contract (HTTP/1.1, JSON)

Unchanged from the original `/v1` contract, with one addition: `pull`,
`push`, and `finalize` bodies accept an optional `dataFileUID` addressing a
specific partition (omitted = the legacy/demo log or the unbound default).
`GET /v1/status` keeps its `{ cursor, entries, pendingForApp }` shape (the
attach probe depends on it) and adds `stateRoot` and `partitions` in
partitioned mode. Malformed envelopes are rejected with `400` and never
appended.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `MLO_CLOUD_HOST` | `127.0.0.1` | bind address (loopback only by design) |
| `MLO_CLOUD_PORT` | `8181` | listen port |
| `MLO_CLOUD_STATE_ROOT` | `%LOCALAPPDATA%\mlo-mcp\cloud` | private partitioned state root |
| `MLO_CLOUD_MODE` | `upstream` for real profiles, `local` for the repo demo | default mode for new bindings |
| `MLO_CLOUD_STATE_DIR` | `<repo>\messages` for the demo profile | legacy single-log override (demo semantics) |
| `MLO_CLOUD_WRITE_THROUGH` | unset | stage-2 seam flag; no effect until the vendor experiments land |

The repository's `messages\` directory is **quarantined demo evidence**: it
provably mixes two profiles' history (a foreign full snapshot sits at cursor 4
beside another profile's deltas) and must never seed a real profile's
baseline. The demo profile keeps using it through the legacy override; real
profiles (`MLO_DATA_FILE`) get partitioned private state automatically.

When the port is already held by another mlo-mcp session's endpoint (probed
via `GET /v1/status`), the new session *attaches*: it runs without its own
listener and shares bindings, partitions, and the persisted bootstrap window
through the state root's cross-process locking.

## MCP tool surface

- `cloud_bootstrap` — create/verify the profile binding, require an empty
  target partition (`rebind: true` for an explicit fresh epoch), arm the
  one-time window, and return the operator instructions for the
  Re-synchronize run. Works for both modes.
- `cloud_status` — endpoint config, binding (mode, `dataFileUID`), lifecycle,
  cursor and delta counts, last local stamp, endpoint-mismatch count
  (distinct from bootstrap-required), partition inventory, and upstream
  mirror coverage/health/blindness.
- `add_task` / `add_tasks` / `update_task` / `complete_task` /
  `uncomplete_task` / `delete_task` — unchanged surface
  ([tools.md](tools.md)), now gated: they queue `origin:"mcp"` deltas only on
  a `ready` local-mode partition (legacy demo log stays exempt) and refuse
  upstream-bound profiles until write-through is verified.
- `sync` — triggers `mlo.exe -QuickSync` as before.

## Vendor handoff

Moving a profile between the vendor Cloud and a local-mode partition — in
either direction — is a deliberate workflow, never a proxy toggle:

1. back up the `.ml` profile;
2. use a fresh profile copy for the destination endpoint;
3. run a full Re-synchronize against an empty remote database on that
   endpoint (`cloud_bootstrap` locally; a new Cloud file at the vendor);
4. retire the source-endpoint copy — do not alternate.

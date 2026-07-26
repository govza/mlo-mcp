# mcp-cloud: the local cloud-sync endpoint for the MLO app

`mcp-cloud` is the server's cloud-side half: a loopback HTTP listener on
`127.0.0.1:8181` that MLO's cloud-sync client reaches through the app's HTTP
**proxy setting** (MLO hardcodes the vendor sync URL; the proxy is the
permanent wiring, not a debugging aid). Sync sessions are triggered with the
already-verified `mlo.exe -QuickSync`.

There is **no mode for the user to choose**: every profile runs the
`MLO ↔ mcp-cloud ↔ vendor Cloud` architecture automatically ("upstream" in
the code). A second, internal mode — the endpoint acting as a replacement
cloud with no vendor involved ("local") — exists for disposable/offline test
profiles only and is armed exclusively by the dev script
`scripts/bootstrap-local.ts`. The two never share state, because each sync
endpoint owns its own remote-version namespace and switching a profile
between authorities is unrecoverable (verified live: duplicate-subtree
imports, then foreign-cursor rejections — see
[Switching endpoints is not a reconnect](mlo/cloud-sync.md#switching-endpoints-is-not-a-reconnect)).

## Before you start (required)

1. **Back up the `.ml` profile** (file copy while MLO is closed) before the
   first bootstrap and before ANY sync experimentation. Bootstrap and writes
   are designed to fail closed, but the profile is the single source of your
   data and re-synchronization flows rewrite sync state inside it.
2. **Wire MLO through the endpoint**: cloud sync proxy → `127.0.0.1:8181`,
   and "Use secure connection" **unchecked** for the sync profile. MLO syncs
   fine either way — but with it checked the proxy only carries an opaque TLS
   tunnel: MLO↔vendor sync keeps working while the endpoint sees nothing, so
   bootstrap, the mirror, and MCP writes silently stay dead (`cloud_status`
   reports `mirror.mirrorBlind: true` when this happens). For a LOCAL-bound
   dev profile it is worse than dead: the tunneled sync silently reaches the
   real vendor Cloud, bypassing the local authority — the unrecoverable
   endpoint-switch hazard. The setting is per sync profile; MLO's sync log
   prints "secure connection is OFF for this sync profile" when it is
   correct.
3. **Sync once, then bootstrap**: run one ordinary MLO sync (or `sync`), then
   call `cloud_bootstrap`. Until that bootstrap has completed, read tools work
   but every mutation tool refuses with a pointer to this procedure — an
   ordinary sync alone can never enable writes. One proxied sync arms writes
   until the **resident endpoint** exits, not until the MCP client does (the
   account contact is held in that process's memory only, never on disk).

## Normal operation (upstream)

The architecture is `MLO ↔ mcp-cloud ↔ vendor Cloud`, with no side demoted:

- For MLO's own sync sessions the endpoint is a **transparent proxy**: the
  vendor Cloud remains the only cursor authority, requests and responses pass
  through byte-for-byte, all three operations of one `sessionID` go to the
  same authority, and nothing local generates, rebases, or adopts a cursor.
  The validated envelopes flowing through are passively captured into a
  per-`dataFileUID` **mirror**, ordered by the vendor-assigned versions. A
  capture failure never alters the proxied exchange; it only marks the mirror
  unhealthy in `cloud_status`.
- For MCP reads and writes the endpoint is **one more sync client** of the
  vendor cloud — the same multi-client model that serves desktop + mobile.
  The credentials in the profile's own proxied sync traffic are held strictly
  in memory (never persisted, never logged) and reused for the endpoint's own
  vendor sessions.

**Bootstrap (zero-touch):** after the one ordinary proxied sync,
`cloud_bootstrap` pulls the vendor's complete history from remote version 0
as a client, normalizes the vendor's raw database-shaped history projection
into the canonical ZIP/Cloud schema, validates it as a full snapshot,
materializes it as the mirror baseline, and binds the profile. Every existing
task resolves to its stable UID and complete record afterwards. No MLO
interaction is required.

**Writes:** a mutation tool refreshes the mirror from the vendor (so full-row
authoring never starts from rows a mobile edit superseded), authors complete
82-column records, and commits them in the endpoint's own vendor session — the
vendor assigns the real `newServerTimeStamp`, and MLO receives the change on
its next QuickSync exactly like a remote edit from another device. The
existing queue → QuickSync → verify loop confirms each write against a fresh
export.

Refresh and commit are two calls into the resident endpoint with the authoring
in between, so the endpoint keeps one vendor session open across both and
records the mirror version the author was handed. If the mirror has moved by
commit time — MLO, mobile, or another session changed the cloud file — the rows
this write carries are superseded, so **nothing is uploaded** and the caller is
told to retry; the retry re-authors from the current rows. The mirror only
advances on real content, so this fires exactly when a full-row rewrite would
otherwise have clobbered a concurrent edit.

The commit trusts cursor movement, not the vendor's `Result` flag: the vendor
has been observed answering `Result=true` while keeping `newServerTimeStamp`
at the current high-water, which stores nothing any sync client will ever
pull (observed live 2026-07-26; five writes vanished while reported as
queued). Such an **unadvanced commit** — like a success response missing
`newServerTimeStamp` entirely — is refused, the caller's words are preserved
in the dead-letter file, and nothing is reported as queued. Every vendor
exchange the endpoint makes as a client is journaled to
`<stateRoot>/vendor-client.jsonl` (cursor values, result flags, payload
sizes — never credentials), so a refused commit leaves durable evidence even
though the resident's stderr dies with it.

**Operational precondition:** MLO's cloud login must have "Use secure
connection" **unchecked**. A TLS `CONNECT` to the vendor sync host tunnels
end-to-end, blinding the mirror and hiding the credentials the client sessions
need; the endpoint records this and `cloud_status` reports
`mirror.mirrorBlind: true`. Vendor contacts last as long as the resident
endpoint process: after it restarts, one proxied sync must happen before writes
resume.

## Local mode — dev/testing only (`scripts/bootstrap-local.ts`)

The replacement-server behavior, hardened: the endpoint terminates the three
sync operations itself and owns the cursor namespace. Not exposed through the
MCP tool surface — it exists for disposable/offline rehearsal profiles. A
local-mode profile must **never** sync against the vendor endpoint again;
returning to the vendor is a fresh full re-synchronization against an empty
vendor file, with a separate profile copy.

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
  unbound-sightings.json        dataFileUIDs seen syncing with no binding (+ first/last seen)
  soap-summary.jsonl            credential-safe structural traffic summaries
  vendor-client.jsonl           the endpoint's OWN vendor exchanges (cursor values,
                                result flags, payload sizes — never credentials)
  bootstrap/armed.json          the persisted local-mode bootstrap window (+ staged.zip)
  clients/                      scripts/cloud-client cursor files (unbound default state)
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
  through an explicit bootstrap: the pull-bootstrap requires exactly one
  unbound candidate among the UIDs whose sync traffic the proxy has seen;
  the local-mode armed window accepts exactly one previously unknown UID and
  disarms if a second appears. One UID serves one profile; a binding's mode
  never changes silently (`rebind: true` starts a fresh partition and
  re-bootstraps; the old partition stays on disk as evidence).
- Partition lifecycle: `uninitialized` → `bootstrap-required` → `ready`.
  Mutation tools fail fast before queueing anything unless the partition is
  `ready`; their error directs to `cloud_bootstrap`, because an ordinary
  QuickSync cannot hydrate pre-existing tasks.
- A **binding mismatch** — the bound profile syncing under a different
  `dataFileUID` — refuses writes too, and is reported by `cloud_status`
  ([ADR-0002](adr/0002-report-binding-mismatch-never-repair-it.md)). Nothing is
  repaired automatically: rebinding changes which authority owns the profile's
  history. See [When the app syncs a UID the server does not
  manage](#when-the-app-syncs-a-uid-the-server-does-not-manage).

## When the app syncs a UID the server does not manage

An unbound `dataFileUID` in proxy position is forwarded to the vendor without
capture — the endpoint stays out of the way of profiles it was not asked to
manage. That branch is unchanged, but the observed UID and a timestamp are now
recorded in `unbound-sightings.json`, because the authority decision is the
only place that ever learns the identity MLO actually syncs.

When the configured profile **is** bound and a still-unbound UID has been seen,
that is a **binding mismatch**: the bound partition is one the app never reads,
so every write into it would vanish while MLO's own sync keeps reporting
success. `cloud_status` reports `bindingMismatch: true` alongside the bound
`dataFileUID` and the `unboundSightings` list; write tools refuse before
building or queueing anything, naming both UIDs, the profile, and the remedy.
Reads keep working throughout, in any sync mode.

A profile with **no** binding is first-run setup, not a mismatch: the sighting
is recorded and listed (it is the bootstrap candidate), but no mismatch is
raised and the write refusal stays the ordinary "run `cloud_bootstrap`" one.
That rule is what keeps the "stay out of the way" guarantee intact.

The remedy is never automatic. Back up the `.ml` profile, then
`cloud_bootstrap { rebind: true }` from the MCP client that **owns** the
endpoint binds the observed UID into a fresh partition; the old one stays on
disk as evidence. Rebinding changes which sync history the profile follows and
cannot be undone. The signal clears itself once the observed UID is bound —
nothing expires on a timer, so a mismatch never stops refusing writes while the
fault is still there ([ADR-0002](adr/0002-report-binding-mismatch-never-repair-it.md)).
If the sighting turns out to be a genuinely foreign profile that synced through
the same proxy, delete `unbound-sightings.json` from the state root.

## Bootstrap flows

**Upstream (zero-touch):** `cloud_bootstrap` pulls the vendor's complete
history from remote version 0 in the endpoint's own client session — full by
construction, so no MLO interaction is needed beyond the one ordinary proxied
sync that exposed the contact.

**Local (Re-synchronize):** `cloud_bootstrap { mode: "local" }` arms a
persisted one-time window; MLO's **Re-synchronize** shows a confirmation only
and runs `Get → Apply(full snapshot) → Get → Release`
([details](mlo/cloud-sync.md#re-synchronize)). With Bidirectional, no
exclusions, and an empty partition, MLO uploads its complete database — every
task as a complete 82-column row with its stable UID, possibly with historical
tombstones. Detection is **armed session + validated coverage**, never a
counter value.

Either way the snapshot must validate before the partition turns `ready`:
the exact supported `TodoItems` header and row width, valid unique UIDs,
resolved acyclic parents, tombstones disjoint from live rows, resolving
context/flag/dependency/ordering references, `FileVersion` 3, and verbatim
preservation of unknown sections/columns/cells. The local-mode upload
additionally requires a `Config` section — the captured full-upload marker
that separates a genuine Re-synchronize from an incremental delta arriving
while armed (a client pull from version 0 needs no such marker). A passing
snapshot is materialized transactionally (temp + fsync + pointer rename) as
the partition baseline; a failing local-mode upload is refused (MLO keeps its
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
specific partition (omitted = the unbound default state).
`GET /v1/status` keeps its `{ cursor, entries, pendingForApp }` shape and adds
`stateRoot`, `partitions`, `version`, and `contactUids`. The attach probe
recognises one of our endpoints by `cursor` and `entries` alone — the two fields
every build has always served — which is what keeps a pre-resident build
identifiable to a session that has to replace it. Malformed envelopes are
rejected with `400` and never appended.

The endpoint-lifecycle routes (`/v1/upstream/*`, `/v1/shutdown`) are described
under [The resident endpoint](#the-resident-endpoint); they are a contract
between mlo-mcp processes, not part of what MLO ever sees.

## Configuration

No configuration is needed: the data file is auto-detected from the profile
MLO has open — the registry's `LastDBFile` proposes it and the running app
confirms it ([ADR-0004](adr/0004-ground-truth-the-open-profile.md)) — it
follows profile switches, and the server refuses to start when it cannot
establish which profile the app has open. The app's open profile is the only
one the server can fully operate on (reads drive `mlo.exe`, writes ride that
profile's sync), so there is no profile setting; the test suite pins temp
copies with an internal `--data-file=` argument.
A profile's authority mode
is not configuration at all: `cloud_bootstrap` always sets up the vendor-
in-the-loop architecture; only the dev script can bind a profile local.

| Env var | Default | Meaning |
|---|---|---|
| `MLO_CLOUD_HOST` | `127.0.0.1` | bind address (loopback only by design) |
| `MLO_CLOUD_PORT` | `8181` | listen port |
| `MLO_CLOUD_STATE_ROOT` | `%LOCALAPPDATA%\mlo-mcp\cloud` | override for tests/unusual installs only |

The repository's `messages\` directory is **archived evidence only**: it
provably mixes two profiles' history (a foreign full snapshot sits at cursor 4
beside another profile's deltas), is no longer read or written by the server,
and must never seed any profile's baseline. Every profile — the repo demo
included — gets a partition under the private root and goes through
`cloud_bootstrap`.

## The resident endpoint

The listener is **its own long-lived process**, not something an MCP session
owns ([ADR-0003](adr/0003-resident-endpoint.md)). MLO's proxy points at the port
permanently, so a listener that died with the agent session that happened to
start it took MLO's sync down machine-wide.

- **Sessions never bind the port.** Every MCP session probes `GET /v1/status`,
  starts the resident detached if nothing answers, and attaches — on every path.
  There is no `owner` / `attached` lottery left to reason about.
- **Nothing new to install.** The resident is this same package's entry point
  re-invoked with `--serve-cloud`, spawned detached, silent and windowless so it
  survives the session that started it. If it ever dies, the next session starts
  another. `scripts/serve-cloud.ts` still runs one in the foreground for
  debugging.
- **The boot window stays open** by decision: MLO launching and syncing before
  any agent session has run since boot finds nothing listening. That is a failed
  sync MLO retries, not data loss — the accepted price of auto-spawn over a
  Scheduled Task.
- **A newer session replaces a stale one.** `/v1/status` reports the build; a
  session running a strictly newer version asks the resident to exit, waits for
  the port, and starts its own. Equal or older versions attach quietly, so a
  stale window cannot downgrade a fresh endpoint.
- **A foreign listener on the port is still a hard error** — MLO's sync proxy
  points there, so it has to be freed (or `MLO_CLOUD_PORT` changed and the proxy
  repointed).

Sessions share bindings, partitions, the mirror and the persisted bootstrap
window through the state root's cross-process locking, and author their own
deltas. The **only** thing they cannot do for themselves is act as a vendor sync
client, because the account contacts are scraped from MLO's proxied traffic and
held in the resident's memory alone. So exactly three operations are forwarded:

| Route | What it lends |
|---|---|
| `POST /v1/upstream/refresh` | opens a vendor session, pulls into the mirror, returns a session token and the mirror version |
| `POST /v1/upstream/commit` | uploads one authored envelope in that session (refuses if the mirror moved) |
| `POST /v1/upstream/history` | the vendor's complete history from version 0, for `cloud_bootstrap` |

`POST /v1/shutdown` exists for the version-skew handoff above. `GET /v1/status`
additionally reports `version` and `contactUids` (which cloud files the endpoint
can currently act as a client for — an inventory, never credentials).

Validation, materialization, binding and delta authoring all stay in the calling
session: the resident lends credentials, it does not execute tools.

**These routes are unauthenticated, by decision.** `/v1/upstream/commit` lends
stored vendor credentials to any caller, and loopback on Windows is reachable by
every account on the machine — so any local account can drive writes to the
user's cloud data through the endpoint. A shared token was considered and
declined ([ADR-0003](adr/0003-resident-endpoint.md)); it is stated here so nobody
assumes a protection that is not there.

## MCP tool surface

- `cloud_bootstrap { rebind? }` — automatic one-time setup: verifies the
  profile binding, pulls the vendor's full history immediately, and returns
  `bootstrapped: true` with the materialized version and counts.
  `rebind: true` discards the current binding for a fresh partition (the old
  one stays on disk as evidence). Every precondition — a reachable endpoint, the
  candidate UID, its vendor contact, and the vendor pull itself — is checked
  **before** the binding moves, so a failed attempt leaves the existing binding
  exactly as it was. Works from any client.
  Local-mode arming is not part of this tool (`scripts/bootstrap-local.ts`).
- `cloud_status` — endpoint config, binding (mode, `dataFileUID`), lifecycle,
  cursor and delta counts, last local stamp, endpoint-mismatch count
  (distinct from bootstrap-required), partition inventory, upstream mirror
  coverage/health/blindness, `endpoint` (url, whether the resident process is
  reachable right now, and its build), and the binding-mismatch signals
  (`bindingMismatch`, `unboundSightings`).
- `add_task` / `add_tasks` / `update_task` / `complete_task` /
  `uncomplete_task` / `delete_task` — unchanged surface
  ([tools.md](tools.md)), gated on a bootstrapped (`ready`) partition. Local
  mode queues `origin:"mcp"` deltas on the replacement endpoint; upstream
  mode commits them in the endpoint's own vendor client sessions.
- `sync` — triggers `mlo.exe -QuickSync` as before.

## Vendor handoff

Moving a profile between the vendor Cloud and a local-mode partition — in
either direction — is a deliberate workflow, never a proxy toggle:

1. back up the `.ml` profile;
2. use a fresh profile copy for the destination endpoint;
3. run a full Re-synchronize against an empty remote database on that
   endpoint (`cloud_bootstrap` locally; a new Cloud file at the vendor);
4. retire the source-endpoint copy — do not alternate.

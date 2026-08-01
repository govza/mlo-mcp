# mcp-cloud: the local sync endpoint for the MLO app

`mcp-cloud` is the server's cloud-side half: a loopback HTTP listener on
`127.0.0.1:8181` that MLO's cloud-sync client reaches through the app's HTTP
**proxy setting** (MLO hardcodes the vendor sync URL; the proxy is the
permanent wiring, not a debugging aid). It runs as its own long-lived
process — the **resident endpoint** ([ADR-0003](adr/0003-resident-endpoint.md)).

Its whole job is to sit in the middle of MLO's own sync sessions:

- **forward them**, byte-for-byte, to the vendor Cloud, which stays the only
  cursor authority;
- **capture** the task rows flowing past into a per-cloud-file row store, so
  MCP writes can author complete records;
- **inject** MCP writes into the sessions MLO already runs, so a write reaches
  the profile through MLO's own merge logic.

The endpoint is not a replacement cloud, not a mirror, and not a second sync
client except for one guarded moment (initialization, below). The architecture
is decided in [ADR-0005](adr/0005-layered-rearchitecture-local-landing-writes.md);
its contract is [the target-architecture spec](adr/0005-target-architecture-spec.md).

## Before you start (required)

1. **Back up the `.ml` profile** (file copy while MLO is closed) before the
   first initialization. Writes are designed to fail closed, but the profile is
   the single source of your data and sync flows rewrite sync state inside it.
2. **Wire MLO through the endpoint**: cloud sync proxy → `127.0.0.1:8181`, and
   "Use secure connection" **unchecked** for that sync profile. MLO syncs fine
   either way — but with it checked the proxy only carries an opaque TLS
   tunnel: MLO↔vendor sync keeps working while the endpoint sees nothing, so
   the row store stays empty and writes never bind. The endpoint records the
   `CONNECT` as a `tls-connect-seen` capture outcome, which `cloud_status`
   surfaces. The setting is per sync profile; MLO's sync log prints "secure
   connection is OFF for this sync profile" when it is correct.
3. **Sync once.** That is the whole setup. The first proxied sync gives the
   endpoint the cloud file's identity and the account contact it needs, and
   initialization then runs by itself (next section). Until a binding exists,
   reads work and writes refuse with a typed kind naming the guard that stopped
   them — there is no bootstrap tool to run.

## Initialization: guarded, automatic, once

Binding a profile to a cloud file is the **only** thing that makes the endpoint
call the vendor itself, and it is a private act of the resident process — no
credential ever crosses a process seam, and there is no route that asks for
one. Three guards stand between an observed sync and a binding
(`src/cloud/auto-init.ts`):

1. no binding exists for the profile the running app has open (rebinding stays
   explicit);
2. exactly one candidate `dataFileUID` has synced through the proxy;
3. the candidate **ground-truths** against that open data file.

Ground-truthing compares contents, not identity: the `dataFileUID` appears
nowhere inside the `.ml`, so the check matches the task GUIDs recorded in the
open file's own footers against the task UIDs in the pulled history. Neither
side is a superset of the other (cloud-written and recurring tasks have no
footer; a full history holds tasks the local file has since deleted), so it
refutes on exactly one observation: two non-empty identity sets with nothing in
common — what a *foreign* profile's cloud file looks like. Guard 3 is what
kills the foreign-profile hazard, because another profile syncing through the
same endpoint is a lone candidate too.

**The binding is written last.** The pull, the parse-verify, the ground-truth
check and the row-store materialization all happen first, so any partial
failure leaves no binding behind and the next proxied sync simply tries again.
A failed guard is a typed refusal naming it (`no-bootstrap-candidate`,
`ambiguous-bootstrap-candidate`, `candidate-not-ground-truthed`,
`no-open-profile`, `auto-init-pull-failed`, `auto-init-materialize-failed`),
which is also what a write refuses with while the profile is unbound.

**Steady-state invariant:** endpoint-initiated vendor calls = 0. Every vendor
exchange after initialization is an MLO-initiated session forwarded through the
proxy. Nothing is periodic.

## The write path

A write never touches the `.ml` file and never uploads anything itself. It
rides MLO's own sync session (spec section 2; proven live for all four verbs):

1. A write tool calls OutlineService, which authors complete 82-column rows —
   adds from scratch, update/complete from the row store's latest captured row,
   delete as a UID tombstone — and hands them to the repository.
2. `POST /v1/write` **durably accepts**: the rows are fsync'd into the bound
   partition's injection queue before `accepted` exists. A resident that is
   down or unspawnable is a typed retryable refusal (`endpoint-down`), never a
   spool.
3. The resident injects pending rows into every forwarded
   `GetModificationsBytesEx` response **for the bound `dataFileUID` only** (the
   binding is the injection gate; every other UID forwards verbatim) and
   presents `vendorVersion + 1`. The bump is transient — MLO stores the
   vendor's real `newServerTimeStamp` after its own Apply.
4. When MLO's ~90 s background `GetFileTS` poll arrives and the queue is
   non-empty, the resident answers with the same advanced stamp it will present
   on the Get; verbatim otherwise. That is what gives a pure-MCP write on a
   quiet MLO a session to ride: `-QuickSync` opens **no** session when MLO
   believes nothing changed.
5. `mlo.exe -QuickSync` stays a best-effort accelerator inside the repository,
   never load-bearing, and always invoked with the explicit data-file path.
6. A row is **delivered** when the resident observes MLO's own Apply carry that
   UID **with matching content**. The content compare is mandatory: answering
   MLO's conflict dialog local-wins uploads the user's row for the same UID and
   is indistinguishable from delivery by UID alone. That outcome is
   **superseded**.
7. A row that has not delivered within the TTL (default 15 minutes,
   `MLO_WRITE_TTL_MINUTES`) is never injected again: it expires into the
   dead-letter record and shows in `cloud_status`.
8. Re-delivery is a safety net, not the main path — MLO self-heals a
   transport-failed Apply by retrying from unchanged stamps, and an eager
   re-injection would fight that retry.

`GET /v1/write/:id` answers the five-state status
(`accepted | delivered | verified | expired | superseded`). `verified` is the
advisory export re-align on top of `delivered`: it is part of the contract and
the enum, and nothing produces it yet — `delivered` is the terminal success
state a caller sees today. Tool-level semantics are in [tools.md](tools.md).

**The non-interference invariant** governs all of it:

> For every exchange MLO initiates through the proxy, the endpoint forwards the
> vendor's response — enriched (injected rows, bumped stamp) when the write path
> has work and composes successfully, verbatim when it doesn't or when composing
> fails for any reason. The only failure MLO may ever observe is genuine
> transport failure to the vendor (502).

No state or failure of capture, row store, injection queue, binding, partition
or service may block, delay or corrupt a forwarded exchange. Structurally: the
forward path reads nothing that can refuse, capture is a contained tap, and
injection's mandatory fallback is the vendor's original payload. `unit`'s
sabotage suite fault-injects every one of those subsystems and asserts the
proxied sync still completes with the vendor's payload intact.

## Partitions, binding, state layout

All state lives under a private root **outside the checkout** (default
`%LOCALAPPDATA%\mlo-mcp\cloud`, restricted to the current user via a
best-effort `icacls` on creation). The layout is private to the repository
tier — nothing above `PartitionStore` knows these paths:

```text
<stateRoot>/
  bindings.json                 { bindings: [{ profilePath, mode, dataFileUID?, boundAt?, createdAt }] }
  unbound-sightings.json        dataFileUIDs seen syncing with no binding (+ first/last seen)
  dead-letters.json             refused writes' text, bounded, never replayed
  soap-summary.jsonl            credential-safe structural traffic summaries
  vendor-client.jsonl           the endpoint's OWN vendor exchanges — operations, cursor
                                values, result flags, payload sizes, never credentials;
                                what the post-mortem of a failed initialization reads
  .<name>-lock/                 transient lock directories for the files several
                                sessions write (cloud/state-lock.ts)
  partitions/<key>/             key = sha256(normalized dataFileUID), first 16 hex
    meta.json                   { dataFileUID, mode, lifecycle, createdAt, repullRequestedAt? }
    rows.json                   row store: UID -> latest full 82-column row seen
    capture-journal.json        ring of timestamped capture outcomes (the gauge source)
    injection-queue.json        durably accepted writes awaiting injection
    write-outcomes.json         receipts that left the queue: delivered/superseded/expired
```

Rules, all fail-closed:

- Every access path — the SOAP proxy, `/v1`, MCP tools — resolves the same
  partition through the gateway. An unknown `dataFileUID` in proxy position is
  forwarded to the vendor **without capture or injection**: the endpoint stays
  out of the way of profiles it was not asked to manage.
- A profile is never bound to "the last UID seen" — only through the guarded
  initialization above. One UID serves one profile.
- **Rebind and repull reach the resident through state, not a route.** Only the
  resident holds the captured contact, and its HTTP surface is closed, so
  neither verb calls the vendor and neither asks the resident to: `repull`
  leaves a request on the partition (the remedy for a row-store gap, which
  refuses writes with `unknown-row`), and `rebind` backs the `.ml` up and drops
  the binding — which is exactly the condition auto-initialization waits for.
  The resident services both on the next proxied sync. Both live on
  `AdminService`; no tool exposes them yet.
- Partition lifecycle is `uninitialized` → `bootstrap-required` → `ready`.
- `mode: "local"` is a legacy binding value only. The replacement-server mode
  (delta log, cursor authority, `Re-synchronize` bootstrap) was deleted with
  the mirror; a partition still bound that way is refused at the authority
  decision rather than served.

### When the app syncs a UID the server does not manage

The observed UID and a timestamp are recorded in `unbound-sightings.json`,
because the authority decision is the only place that ever learns the identity
MLO actually syncs. When the configured profile **is** bound and a
still-unbound UID has been seen, that is a **binding mismatch**: the bound
partition is one the app never reads, so a write into it would never be
applied while MLO's own sync keeps reporting success. `cloud_status` reports
`bindingMismatch` alongside the bound `dataFileUID` and the `unboundSightings`
list. Reads are unaffected.

A mismatch is now **repaired automatically** on the next proxied sync
([ADR-0007](adr/0007-recover-from-sync-drift-automatically.md)): the abandoned
partition and every write queued in it are discarded, the binding is released,
and the identity MLO actually presents is adopted. Nothing is dead-lettered and
nothing says what was dropped. This reverses
[ADR-0002](adr/0002-report-binding-mismatch-never-repair-it.md), which refused
instead on the grounds that rebinding cannot be undone — a hazard that is now
accepted rather than avoided, and whose one known failure mode (two copies of a
profile syncing through the same proxy) is written down there.
A profile with **no** binding is first-run setup, not a mismatch — the sighting
is the initialization candidate. The sightings file keeps only the most recent
few with their first/last-seen stamps — a diagnostic marker to read against the
clock, not a stored verdict: a last-seen far in the past says MLO has not been
syncing through the proxy.

Behind-the-back vendor sync — MLO syncing with the proxy off — is **drift, not
an error**: there is no version-authoritative local state left to defend (the
stamp bump is transient), so the old endpoint-mismatch guard died with the
delta log. What surfaces instead: stale sightings, row-store gaps refusing with
the `repull` remedy, and pending writes expiring at TTL.

## Gauges, not latches

Health is derived per query from the capture journal and the sighting recency
window; bad observations age into irrelevance. `mirror-blind.json` /
`mirror-health.json` are gone as a class. Two gauges matter operationally:

- **Capture outcomes** — `ok | failed | skipped | tls-connect-seen` per
  exchange. A capture failure never alters the proxied exchange.
- **Session held open** — a Get with no following Apply beyond ~30 s is the
  endpoint's only cross-process view of a pending conflict dialog;
  `cloud_status` reports it as delivery stalled, likely awaiting user input in
  MLO.

The dead-letter file stays a bounded consolation record — never read as health,
never replayed. Recovery is reading it by hand.

## Wire contract

The complete non-proxy surface, HTTP/1.1 on loopback. Everything else answers
404; `/v1/upstream/*` and `/v1/pull|push|finalize` were deleted with credential
lending and the second sync protocol.

| Route | Contract |
|---|---|
| `POST /v1/write` | `{ profile, rows }` → `{ writeId, uid, verb, caption?, status: "accepted", expiresAt }`. Resolves only after the queue write is fsync'd |
| `GET /v1/write/:id` | `{ writeId, uid, verb, caption?, status, expiresAt?, at?, detail? }` — `accepted` from the queue, the resolved state from the outcome ring, `problem+json` 404 once a receipt ages out. The `remedy` a caller sees is attached at the tool layer |
| `GET /v1/status` | `{ stateRoot, partitions, version, contactUids, writesHeldOpen }` — the attach probe, the build a newer session compares against, and the one write fact that lives nowhere but this process |
| `POST /v1/shutdown` | the version-skew handoff; answers first, then stops |

Refusals are RFC 9457 `application/problem+json`: `type: "urn:mlo-mcp:<kind>"`,
`title`, `retryable`, plus the kind's typed fields as extension members. The
session client rehydrates them and never throws; an unrecognized `type` becomes
`{ kind: "unknown", type, title, retryable }` — degraded, never lost. HTTP
status stays meaningful but decorative; the `kind` is the contract.

**These routes are unauthenticated, by decision.** Loopback on Windows is
reachable by every account on the machine, so any local account can queue
writes into the bound partition. What is *not* reachable any more is the
vendor: no route lends a credential, and the endpoint never uploads on a
caller's behalf. A shared token was considered and declined
([ADR-0003](adr/0003-resident-endpoint.md)); it is stated here so nobody
assumes a protection that is not there.

## The resident endpoint

The listener is its own long-lived process, not something an MCP session owns.
MLO's proxy points at the port permanently, so a listener that died with the
agent session that happened to start it took MLO's sync down machine-wide.

- **Sessions never bind the port.** Every session probes `GET /v1/status`,
  starts the resident detached if nothing answers, and attaches — on every
  path. The `ResidentClient` does this lazily, on the call that needs it, so a
  resident that dies mid-session comes back on the next write instead of
  requiring a client restart.
- **Nothing new to install.** The resident is this same package's entry point
  re-invoked with `--serve-cloud`, spawned detached, silent and windowless.
  `scripts/serve-cloud.ts` runs one in the foreground for debugging.
- **The boot window stays open** by decision: MLO launching and syncing before
  any agent session has run since boot finds nothing listening. That is a
  failed sync MLO retries, not data loss — the accepted price of auto-spawn
  over a Scheduled Task.
- **A newer session replaces a stale one.** `/v1/status` reports the build; a
  session on a strictly newer version asks the resident to exit, waits for the
  port, and starts its own. Equal or older versions attach quietly.
- **A foreign listener on the port is a startup verdict** (`port-conflict`):
  MLO's proxy points there, so it has to be freed (or `MLO_CLOUD_PORT` changed
  and the proxy repointed). Overwriting it would take MLO's sync down.

The resident follows no profile — partitions are keyed by `dataFileUID`, so a
profile switch is not its business — and it does not exit on a rebuild, because
a replacing session is the one path that guarantees something is still
listening afterwards.

## Configuration

No configuration is needed: the data file is auto-detected by asking the running
MLO which profile it has open, and nothing it saved for next time is read
([ADR-0006](adr/0006-detect-the-open-profile-from-the-process-alone.md)). It
follows profile switches, and a session refuses to start when it cannot
establish which profile the app has open — including when MLO is not running,
since then no profile is open. The resident deliberately does not inherit that
refusal: it must come up before MLO has ever been opened.

| Env var | Default | Meaning |
|---|---|---|
| `MLO_CLOUD_HOST` | `127.0.0.1` | bind address (loopback only by design) |
| `MLO_CLOUD_PORT` | `8181` installed / `8282` from source | listen port; MLO's proxy must match |
| `MLO_CLOUD_STATE_ROOT` | `%LOCALAPPDATA%\mlo-mcp\cloud` | override for tests and unusual installs only |
| `MLO_WRITE_TTL_MINUTES` | `15` | how long an accepted write may wait for MLO's Apply |

The repository's `messages\` directory is **archived evidence only**: it
provably mixes two profiles' history, is no longer read or written by the
server, and must never seed any profile's state.

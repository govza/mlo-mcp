# ADR-0005: Layered re-architecture with local-landing writes

Status: accepted (2026-07-27)
Spec: [0005-target-architecture-spec.md](0005-target-architecture-spec.md)
Effort record: `.scratch/rearchitecture/` (wayfinder map, tickets 01-15, live evidence)

## Context

The server grew organically around a write path in which the endpoint acted as
a second vendor writer: MCP writes were committed to the vendor cloud through
credential lending (`/v1/upstream/refresh|commit`), a mirror projection
(delta log + snapshots) reconstructed cloud state, and every tool embedded its
own pipeline (author delta -> commit -> quickSync -> re-export -> re-align).
The failure history of that shape: vendor-protocol parse errors, MCP writes
stuck or refused, and the vendor cloud complaining about too-frequent
synchronization attempts.

An error-taxonomy audit found 35 halting paths with exactly one typed error in
the tree; everything else is `Error(string)` prose. The resident's typed
409/400/500 refusals collapse to strings at the session seam, so retryable and
terminal failures are indistinguishable except by reading English. Two health
latches (`mirror-blind.json`, `mirror-health.json`) are written and never
cleared by any code path.

Charter constraints fixed at the start of the effort:

- **MLO acts as the database.** Reads come from `mlo.exe` exports; the
  repository layer is the only place that talks to MLO.
- **MCP writes must enter MLO as local edits**, and MLO stays the sole vendor
  writer.
- **The MLO UI allows exactly one Cloud-type sync profile per data file** -
  there is one network sync channel, shared by MCP and vendor sync.
- **Real-time writes only**: an MCP action is always current - authored and
  delivered now, never a stale queued delta - and no other sync client (e.g. a
  phone) is taken into account.
- Individual bugs found on the way are filed as GitHub issues, never fixed
  inside this effort.

## Decision

Three parts, decided together because each makes the others viable.

### 1. Three layers: tools (controllers) / services / repositories

Plus a domain-model tier of pure functions any layer may import, and a
composition root that is not a layer. Calls run strictly downward: a tool
validates its schema and calls exactly one service method; services call
repositories, never each other (the one shared computation, availability, is
an internal engine both read services consume); repositories are the only
code that touches `mlo.exe`, the state root, or the resident process.

Services slice by GTD workflow intent, not entities - in MLO everything is one
entity, so entity-per-service has nothing to slice. The roster: OutlineService
(all writes), NextActionsService (Engage), ReviewService (Reflect), plus an
identity service and an AdminService for the cloud plane. Interfaces are in
the spec.

### 2. Local-landing writes by single-channel injection

The resident endpoint - already the proxy MLO's one Cloud profile syncs
through - injects queued MCP rows into the vendor's forwarded
`GetModificationsBytesEx` response and presents `vendorVersion + 1` as the
returned stamp. MLO applies the rows as remote data, stamps them as fresh
local edits (it has no echo suppression), and re-uploads them to the vendor in
its own following `ApplyModificationsBytesEx` - so MLO remains the sole vendor
writer and the endpoint makes zero vendor calls of its own in steady state.

This is proven live, not predicted: all four verbs (add, update, complete,
delete) were delivered through an injecting proxy into a running MLO,
appeared immediately in the open GUI with zero side effects, and were observed
riding out in MLO's own Apply in the same session (evidence journals in
`.scratch/rearchitecture/`, harness on branch
`prototype/single-channel-injection`).

The bump is admissible only under the real-time-writes constraint. It must
beat MLO's stored remote stamp because MLO's remote-side decision gates on the
returned stamp and never parses the payload unless it advanced (210/210 logged
sessions, zero counterexamples) - so a pass-through response can never
deliver. The bump is transient: MLO stores the vendor's real
`newServerTimeStamp` after its own Apply, so the stored cursor returns to the
vendor's namespace on every propagating write.

Around the mechanism, the write pipeline is:

- `write()` is a **durable accept**: rows are fsync'd into an injection queue
  in the resident before `accepted` is returned; refusals never enter any
  queue (a spooled delta is by definition no longer current).
- The resident injects pending rows into every forwarded Get for the bound
  `dataFileUID` and marks a row delivered when MLO's own Apply echoes it
  **with matching content** - UID presence alone cannot distinguish delivery
  from a conflict-dialog local-wins overwrite.
- When MLO's background `GetFileTS` poll arrives and the queue is non-empty,
  the endpoint answers with the same advanced stamp, inducing MLO to open a
  session (without this, a pure-MCP write on a quiet MLO has no session to
  ride and delivery latency is unbounded). Marked verify-live.
- A row that has not delivered within a TTL (default 15 minutes) expires
  loudly into the dead-letter file - it is never injected stale.

### 3. A non-blocking error contract: failures are values

Every service boundary returns `ServiceResult<T, F>` - a tagged union with a
closed `kind` set per boundary, producer-declared `retryable` and `remedy`,
carried across the session-resident HTTP seam as RFC 9457 problem+json, with
unknown kinds degrading to `{ kind: "unknown" }` rather than crashing.
Failures are assigned one of four blast-radius tiers (event / op refusal /
write-gate refusal / startup verdict); post-startup, no failure stops the
server. Degraded state is computed from recent observations (gauges: capture
journal ring buffer, sighting recency window), never stored as a latch; every
degraded kind must declare the observation that clears it.

The load-bearing invariant, fail-open non-interference: for every exchange MLO
initiates through the proxy, the endpoint forwards the vendor's response -
enriched when injection composes, verbatim when anything at all fails - and
the only failure MLO may ever observe is genuine transport failure to the
vendor. The forward path reads nothing that can refuse. A sabotage test suite
encodes this by fault-injecting every subsystem and asserting a proxied sync
completes intact.

## Options not taken

- **Harden the existing vendor write path** (keep the endpoint as a second
  vendor writer, fix the bugs). Rejected because its worst failures are
  structural, not bugs: credential lending moves the user's vendor credential
  across a process seam; the endpoint's own uploads race MLO's and caused the
  observed vendor rate complaints; and the unadvanced-commit class (vendor
  accepts, cursor does not advance, five consecutive writes vanished) has no
  in-band recovery because the fault is vendor-side. Local landing removes all
  three by construction.
- **Pass-through append** (forward the vendor's `maxVersion` untouched, append
  MCP rows to the payload). Dead: the stamp gate discards the payload unread
  unless the stamp advanced, so delivery would wait for someone else's edit.
- **A derived version namespace** (`vendorVersion * SCALE + minor`). Sound for
  any number of sync clients - every presented value divides back to a true
  vendor version - but it bakes an owned namespace into every profile's stored
  cursor, with a cutover and an exit problem. The only safety it buys over the
  bump is against a second sync client, which the charter rules out of scope.
  Held in reserve (both modes live in the prototype); it is the answer if a
  phone ever syncs the same data file.
- **Second Cloud sync profile as a hub.** Impossible: the MLO UI allows
  exactly one Cloud-type profile per data file.
- **Wi-Fi sync profile / Outlook sync / XML-to-`.ml` replacement / CLI
  verbs** as the write channel. Wi-Fi: protocol lives in an un-reverse-
  engineered DLL that is not even installed. Outlook: lossy property subset,
  fallback only - and no fallback is needed now that all four verbs are proven
  on the main channel. File replacement: the app holds the `.ml` open, there
  is no reload IPC, and closed-app rebuilds regenerate every GUID. The CLI verb
  list is closed at add-only (vendor help + the binary's IPC dispatcher
  enumerated; no update/complete/delete verb exists).
- **A mutable client-side store for read-your-own-writes** (Vuex-style).
  Rejected: MLO is the database, MCP sessions are ephemeral, and refused
  writes would linger as phantoms. Reads instead compose a derived overlay of
  the pending queue over the fresh export, self-emptying on delivery.
- **Per-step migration test gates.** Considered and dropped (user decision):
  the re-architecture is a big-bang change and only the end state can be all
  green. The single acceptance bar is at the end of implementation.

## Consequences

- **The vendor rate complaint is answered by construction**: steady-state
  endpoint-initiated vendor calls = 0; every vendor exchange is an
  MLO-initiated session forwarded through the proxy. The endpoint speaks the
  vendor protocol as a client only during initialization (the guarded
  auto-init full-history pull, or explicit `rebind`/`repull`).
- **Delivery is asynchronous and honestly so.** `mlo.exe -QuickSync` returns
  immediately and MLO syncs on its own cadence (observed 40-80 s, sometimes
  longer; it opens no session at all when it sees nothing new). Write tools
  therefore return at durable accept with an expiry time, and a five-state
  write status (`accepted | delivered | verified | expired | superseded`)
  replaces the old `verified` boolean.
- **A human can stall delivery.** MLO's conflict dialog opens mid-session and
  holds it until answered; local-wins silently overwrites the injected row
  with the user's row for the same UID. The contract carries this as the
  `write-superseded` kind and a session-held-open gauge, not as an error.
- **A known drift-skip is accepted, bounded by scope.** The bumped stamp
  survives an aborted session, so a genuine vendor change later assigned
  exactly that version would be skipped. With no second sync client, nothing
  can take that version except MLO's own next upload. Live, the common
  transport-failure case self-healed (MLO retried in 3 s from unchanged
  stamps); verify-and-re-deliver stays as a safety net for the historic
  abort-persistence case. If a phone ever syncs the same file, this
  assumption and the derived namespace question reopen (see the reserved
  option above).
- **Update/complete structurally require captured traffic.** Authoring a full
  82-column row from the XML export would silently clobber data, so the row
  store (UID -> latest full row seen in any captured payload) is seeded once
  by the bootstrap pull and kept complete by passive capture. An update to a
  row never seen in traffic is a typed refusal healed by `repull`.
- **A large body of code is deleted**: the whole mirror projection apparatus,
  credential lending, the `/v1/upstream/*` routes, the second sync protocol,
  and the endpoint-mismatch guard (the target has no version-authoritative
  state to defend; behind-the-back vendor sync becomes gauge-visible drift).
  The spec carries the full deletion list.
- **The migration is big-bang** with lint/typecheck during and one acceptance
  bar at the end: all suites green, including one `MLO_LIVE=1` pass of the
  live items (the `GetFileTS` nudge, four-verb propagation, TTL expiry).

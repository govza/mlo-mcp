# Target-architecture spec: layered server with local-landing writes

Companion to [ADR-0005](0005-layered-rearchitecture-local-landing-writes.md),
which records the decision and its alternatives. This spec is the contract for
the implementation effort. Sources: wayfinder effort `.scratch/rearchitecture/`
(tickets 01-15); live evidence journals and the prototype harness on branch
`prototype/single-channel-injection`.

## 1. Layer model

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

Rules:

- Calls run strictly downward. Services never call each other; the one shared
  computation is the internal AvailabilityEngine (section 3).
- Tools keep exactly: input schema validation + calling one service method.
- `ToolContext` is **required services only**: `{ outline, nextActions,
  review, admin, config, log }`. No repositories, no optional fields - the
  historic `ctx.cloud`-absent silent downgrade becomes unrepresentable.
  Repositories are wired into services once, at the composition root.
- The domain model tier (delta schema / CSV / envelope / cursors / task tree /
  XML parsing) stays pure and side-effect free.

## 2. The write path

### Mechanism (proven live, all four verbs)

1. A write tool calls OutlineService, which authors full 82-column rows (adds
   from scratch; update/complete from the row store's latest captured row;
   delete as a UID tombstone) and calls `MloRepository.write(rows)`.
2. `write()` durably accepts: rows are fsync'd into the resident's injection
   queue (single writer: the resident, reached via `POST /v1/write`) before
   `accepted` is returned. Resident down or unspawnable is a typed retryable
   refusal (`endpoint-down`) - never a spool.
3. The resident injects pending rows into every forwarded
   `GetModificationsBytesEx` response for the **bound dataFileUID only** (the
   binding is the injection gate; every other UID forwards verbatim) and
   presents `vendorVersion + 1`. The bump is transient - MLO stores the
   vendor's real `newServerTimeStamp` after its own Apply.
4. When MLO's ~90 s background `GetFileTS` poll arrives and the queue is
   non-empty, the resident answers with the same advanced stamp it will
   present on the Get; verbatim otherwise. This induces a session for
   pure-MCP writes on a quiet MLO. **verify-live** (section 9).
5. `mlo.exe -QuickSync` stays a best-effort accelerator inside the repository
   implementation, never load-bearing (it opens no session when MLO sees
   nothing new; always invoked with the explicit data-file path - section 5).
6. The resident marks a row **delivered** when it observes MLO's own Apply
   carry the row's UID **with matching content**. Content comparison is
   mandatory: a conflict-dialog local-wins resolution uploads the user's row
   for the same UID and is indistinguishable from delivery by UID alone -
   that outcome is **superseded**, not delivered.
7. An accepted row that has not delivered within the TTL (**default 15
   minutes**, configurable) is never injected again: it expires into the
   dead-letter file and emits a typed `write-expired` event.
8. Re-delivery is a safety net, not the main path: MLO self-heals a
   transport-failed Apply (retries in 3 s from unchanged stamps, exactly-once
   delivery observed). Re-deliver only when the queue row is neither
   delivered nor expired and no session is in flight; an eager re-delivery
   would fight MLO's own retry.
9. `verified` stays an advisory session-side export re-align on top of
   delivered.

### Tool-facing contract

Write tools return immediately at durable accept:

```jsonc
{ "uid": "{...}", "writeId": "...", "status": "accepted",
  "expiresAt": "HH:MM", "message": "accepted - lands on MLO's next sync; expires at HH:MM if MLO doesn't sync" }
```

- **Write status is a five-state enum keyed by `writeId`** (the durable-accept
  receipt; two queued writes can share one uid):
  `accepted | delivered | verified | expired | superseded`.
- **New tool `write_status(writeId)`** returns
  `{ writeId, status, expiresAt?, detail, remedy? }`.
- **`cloud_status` gains the aggregate** - the only surface for outcomes
  nobody is waiting on (writeId receipts die with the ephemeral MCP session):
  `{ pendingWrites, oldestPendingAge, recentDeadLetters: [last N
  expired/superseded with uid + caption + reason], sessionHeldOpen }`.
- **Read-your-own-writes overlay: ON.** `MloRepository.snapshot()` composes
  the fresh export + pending-queue rows at read time - derived, no new state
  store, self-emptying as the queue drains. All four verbs overlay (add =
  phantom row, update = merged fields, complete = shown completed, delete =
  hidden). Overlaid tasks carry `pending: true` + the `writeId` in tool
  output. On expiry/supersede the overlay entry drops silently and reads
  revert to export truth - loudness lives in `write_status` / `cloud_status`,
  never in the read path.

## 3. Service layer

Slicing axis: GTD workflow intent (Capture/Clarify/Organize -> Reflect ->
Engage), not entities. Three services + one internal engine + identity +
admin.

### OutlineService (all writes)

Charter: every mutation of the outline; owns the rules that make a write
sensible (inbox defaulting, recurrence roll-forward,
contexts-are-full-list-replace) and authors the 82-column rows.

Interface sketch: `add(spec)`, `addMany(tree)`, `capture(line)` (rapid-entry
parse), `update(id, patch)`, `complete(id)` / `uncomplete(id)`, `delete(id)`,
`move(id, newParent, position)`, plus Organize verbs (`makeProject`,
dependencies, sequencing). Forbidden to know: scoring/ranking, view logic, the
vendor protocol. Depends on: MloRepository, identity, the row store (via
repository seams).

### NextActionsService (Engage)

Charter: compute the To-Do list an MLO user would see. Interface:
`nextActions({context?, maxTimeMin?, maxEffort?, availableOnly?})` (ranked),
`today()` / `forecast(date)`, `starred()`. Behind it: the leaf rule,
Folder/Hide flags, complete-in-order, dependency blocking, start-date
availability, hierarchical context expansion, context open/closed hours,
computed score. Read-only; forbidden to know the write channel, identity
binding, the vendor protocol.

### ReviewService (Reflect)

Charter: surface everything that erodes trust in the system. Interface:
`reviewDue()`, `projects(status)`, `stalledProjects()` (in-progress project
with zero available next action), `somedayMaybe()`, `waitingFor()`,
`goals(horizon)`, `inbox()`, `completedLog(range)`, `hygiene()` (no-context
leaves, dangling deps). Read-only, same prohibitions.

### AvailabilityEngine (internal, not a public service)

The availability + leaf-visibility computation both read services consume
(leaf rule, flags, dependencies, start dates, context hours). Own tests, no
public interface. Scoring may live here or stay private to NextActionsService.

### Identity service

One owner for "which row is this id": resolver built once per snapshot,
`uidFor`/`taskFor`/confidence; `guids.ts` binary recovery injected as a
cross-check. With the projection deleted, identity aligns the export against
the **row store**, not a mirror snapshot. OutlineService depends on it; read
services do not.

### AdminService (cloud plane)

`status()` (gauge-derived), `rebind()` (explicit, with backup), `repull()`
(refresh the row store from a fresh full-history pull without touching the
binding - the remedy for row-store gaps). `cloud_status` / `cloud_bootstrap`
sit on it.

Deliberately not built: a generic filter/query DSL (named intent-revealing
queries beat a query language for LLM callers), separate
Capture/Clarify/Organize services, a stats service.

## 4. Repository layer

Two deep repositories, small stores, a named driver tier inside.

### MloRepository (deep; hides the process seam entirely)

```ts
interface MloRepository {
  snapshot(): TaskTree                      // fresh mlo.exe export + pending-write overlay
  write(rows: DeltaRow[]): PendingWrite     // durable accept
  status(id: WriteId): WriteStatus          // five-state enum (section 2)
}
```

No service ever learns a resident exists. The implementation spans both
processes (queue/inject/observe-Apply in the resident; QuickSync nudge and
export-verify session-side). Deliberately domain-specific: one aggregate +
four verbs.

### PartitionStore (per dataFileUID; the renamed MirrorRepository)

The per-cloud-file handle, layout fully private. It mirrors nothing anymore;
it holds: the **row store** (UID -> latest full 82-column row seen in any
captured payload), the **capture journal** (ring buffer of timestamped
outcomes: `ok | failed | skipped | tls-connect-seen` - the gauge source), the
**injection queue**, and beside it the small **Binding**, **Sightings**
(timestamped, recency-windowed), and **DeadLetter** stores.

### Drivers (named internal seams, constructor-injected, invisible above)

```ts
interface MloCli {                          // wraps mlo-cli.ts; its three module-level
  exportXml(): Xml                          // singletons (promise-chain mutex, file-lock
  quickSync(): void                         // flag, export counter) stay process-wide
  readDataFile(): Buffer
}
interface ResidentClient {                  // the HTTP hop; lazy attach-and-spawn
  postWrite(rows: DeltaRow[]): Accepted
  writeStatus(id: WriteId): QueueState
  probe(): EndpointStatus
}
```

`MloCli` constraints from live findings: always pass the explicit
data-file path (pathless invocations against an open GUI can silently no-op
with exit 0); never let a caption parse as `<FileToOpen>` (spawns a second
instance). `ResidentClient` attaches - and spawns, if the port is free - on
the call that needs it, not once at session start.

Two-level fakes: fake drivers test the repository implementation; fake
repositories test services (section 8).

### Resident HTTP surface (complete)

SOAP proxy + injection, `POST /v1/write`, `GET /v1/write/:id`,
`GET /v1/status`, `POST /v1/shutdown`. Nothing else. `/v1/upstream/*` and
`/v1/pull|push|finalize` are deleted.

## 5. Cloud plane

- **The mirror-as-projection is deleted** (delta log, snapshot store,
  log-projection, structure-align, snapshot-validate). Reads come solely from
  the local export; update/complete authoring comes from the row store.
- **Bootstrap's one-time full-history pull is kept**, as a private act of the
  resident: after a proxied sync, if the auto-init guards pass, the resident
  pulls, validates fully (materialize the row store, parse-verify,
  ground-truth against the running app), and only then writes the binding. A
  half-pulled state leaves no binding behind. No credential ever crosses the
  process seam; credential lending is deleted entirely.
- **Auto-initialization guards** (replacing the `bootstrap-required`
  refusal): auto-bind only when (1) no binding exists, (2) exactly one
  candidate UID observed, (3) the candidate ground-truths against the running
  MLO app's open data file. Any failed condition is a typed write-gate
  refusal naming it. Rebind stays explicit, with backup.
- **The binding is the injection gate**: inject only into forwarded sessions
  whose dataFileUID matches the bound UID; all else verbatim.
- **Behind-the-back vendor sync is drift, not an error**: the
  endpoint-mismatch guard dies with the delta log (no version-authoritative
  state to defend; the bump is transient). Stale sightings show MLO is not
  syncing through the proxy; row-store gaps refuse with the `repull` remedy;
  pending writes expire at TTL.
- **Invariant**: the endpoint initiates vendor calls only during
  initialization - the guarded auto-init pull, or a human-triggered
  `rebind`/`repull`. In steady state, every vendor exchange is an
  MLO-initiated session forwarded through the proxy; endpoint-initiated
  vendor calls = 0. Nothing is periodic.

Two mechanics this spec left open, settled while implementing it:

- **Ground-truthing is task-identity overlap.** The `dataFileUID` appears
  nowhere in the `.ml` file (checked on the live profile: not as text in any
  encoding, not as GUID bytes in either order, in any of its ZIP entries), so
  the candidate cannot be compared to the open profile directly. It is
  compared through its contents instead: the task GUIDs recorded in the open
  `.ml`'s own footers against the task UIDs of the pulled history. Neither
  side is a superset of the other - cloud-written and recurring tasks have no
  footer, and a full history holds tasks the local file has since deleted - so
  the check refutes on exactly one observation: two non-empty identity sets
  with nothing in common, which is what a foreign profile's cloud file looks
  like. An empty side never refutes, the same per-signal permissiveness
  [ADR-0004](0004-ground-truth-the-open-profile.md) applies to its own two.
- **`rebind` and `repull` reach the resident through state, not a route.**
  Only the resident holds the captured contact and its HTTP surface is closed,
  so neither verb calls the vendor and neither asks the resident to: `repull`
  leaves a request on the partition and `rebind` (after backing the `.ml` up)
  drops the binding, which is exactly the condition auto-initialization waits
  for. The resident services both on the next proxied sync, so the pull stays
  a private act of the resident in all three cases.

## 6. Error contract

### Carrier

```ts
type ServiceResult<T, F extends Failure> =
  | { isErrored: false; value: T; advisories?: Advisory[] }
  | { isErrored: true; failure: F };

// every failure kind carries, at minimum:
// { kind: "<closed-union-tag>"; retryable: true | false | "after-user-action"; remedy: string; ...typed fields }
```

Plain tagged objects (class identity dies at the HTTP seam), no Result
library. One closed union per boundary: repositories return infra kinds,
services map them into domain kinds, the tool layer is the only place a
failure becomes prose - once, with the remedy attached. Genuine invariant
violations stay exceptions.

### Wire form

Non-2xx resident responses are RFC 9457 `application/problem+json`:
`type: "urn:mlo-mcp:<kind>"`, `title`, `retryable`, plus the kind's typed
fields as extension members. The session client rehydrates and never throws
on a refusal; an unrecognized `type` rehydrates as
`{ kind: "unknown", type, title, retryable }` - degraded, never lost. HTTP
status stays meaningful but decorative; the `kind` is the contract.

### Blast-radius tiers

| Tier | Meaning | Lives here |
|---|---|---|
| **Event** | Journaled + visible in `cloud_status`; blocks nothing | capture failed/skipped, tls-connect-seen, unbound sightings, version-skew attach, `injection-skipped`, `write-expired`, **`write-superseded`**, queue re-delivery |
| **Op refusal** | This one call returns `isErrored`; next call is fresh | `endpoint-down`, `target-unresolvable`, `unsupported-edit`, `invalid-request`, `lock-timeout`, `unknown-row` (remedy: `repull`), bootstrap-attempt failures |
| **Write-gate refusal** | All writes refuse with the same kind until a state changes; reads and the proxy untouched | `binding-mismatch`, `partition-not-ready`, `no-bootstrap-candidate`, `ambiguous-bootstrap-candidate`, `binding-conflict` |
| **Startup verdict** | Refuse to start, exit 1 - allowed only before serving | profile verdict (`no-profile`/`profile-switched`), `port-conflict` |

Post-startup, no failure stops the server. The mid-session profile-switch
watcher's exit-while-idle is a designed lifecycle restart, not a failure.

`write-superseded` (from the live conflict rounds): the user answered MLO's
conflict dialog local-wins, so their row overwrote the injected write for the
same UID. Advisory tier, no retry - re-injecting would just re-raise the
dialog. Detection requires Apply content comparison.

### Gauges, not latches

`mirror-blind.json` / `mirror-health.json` are deleted as a class. Health is
derived per query from the capture journal and the sighting recency window;
bad observations age into irrelevance. The **session-held-open gauge**: a Get
without a following Apply beyond ~N s is the endpoint's only cross-process
view of a pending conflict dialog; `cloud_status` surfaces it as "delivery
stalled, likely awaiting user input in MLO". The dead-letter file stays as a
bounded consolation record - never read as health, never replayed.

**Review gates** (enforced on the contract table during implementation):
every Event- and write-gate-tier kind declares the observation that ends it;
no kind is assigned a blast radius outside the four tiers.

### Queue and retry discipline

- Gate-time refusals never enter any queue; every write refusal dead-letters
  the caller's words immediately.
- Accepted rows deliver until MLO's Apply confirms, or expire loudly at TTL.
- `retryable`/`remedy` are producer-declared caller metadata; **no automatic
  retries anywhere**. Lazy attach-and-spawn kills the restart-the-client
  remedy class.

### The non-interference invariant (testable)

> For every exchange MLO initiates through the proxy, the endpoint forwards
> the vendor's response - enriched (injected rows, bumped stamp) when the
> write path has work and composes successfully, verbatim when it doesn't or
> when composing fails for any reason. The only failure MLO may ever observe
> is genuine transport failure to the vendor (502). No state or failure of
> capture, row store, injection queue, binding, partition, or any service may
> block, delay, or corrupt a forwarded exchange.

Structural rule: the forward path reads nothing that can refuse. Capture is a
contained tap; injection is a best-effort transform whose mandatory fallback
is the vendor's original payload. Both taps fail open.

## 7. File-level layer assignment

### Target modules from current code

| Target module | Layer | From (current code) |
|---|---|---|
| `MloRepository` (impl: `MloCli` + `ResidentClient` seams) | REPO | `mlo-cli.ts`, `store.ts` (snapshot cache), session half of `cloud/endpoint.ts`, NEW queue routes |
| Injection queue + delivery loop (in the resident, behind `MloRepository`) | REPO impl | NEW; mechanics from branch `prototype/single-channel-injection` |
| `PartitionStore` (row store, capture journal, injection queue, binding/sightings/dead-letter) | REPO | `cloud/partition.ts`, `cloud/binding.ts`, `cloud/sightings.ts`, `cloud/dead-letter.ts`, prototype `rowStore`; layout private |
| `profile-detect` adapter | REPO | `profile-detect.ts`, unchanged role |
| OutlineService | SVC | write pipelines from `tools/*.ts`, write policy from `tools/shared.ts:12-195` |
| NextActionsService / ReviewService / AvailabilityEngine | SVC | NEW (query logic drawn from existing read tools) |
| Identity service | SVC | `resolveTaskUid` + per-tool resolver rebuilds; `guids.ts` injected as cross-check; aligns against the row store |
| AdminService | SVC | `tools/cloud-status.ts` / `tools/cloud-bootstrap.ts` logic; pull transport from `cloud/upstream.ts` (`VendorClient`, `pullVendorHistory`; `materializeVendorHistory` reshaped to materialize the row store) |
| Passive proxy + capture | resident SVC | `cloud/upstream.ts` forward half, `cloud/soap.ts`, `cloud/gateway.ts` authority/pinning; `vendorContacts` in-memory registry survives (powers the pull) |
| Tool contract infra (`defineTool`/`registerTool`/`guard`) | CTRL | `tools/shared.ts` contract stratum -> `tools/contract.ts` |
| `TaskSummary`/`toSummary` DTO | DOMAIN | `tools/shared.ts` presentation stratum |
| Domain model (`delta.ts` split per c8: schema/guid/merge; `csv.ts`, `envelope.ts`, `cursor.ts`, `task-tree.ts`, `xml.ts`) | DOMAIN | unchanged tier, residue deleted |
| Composition-root process infra (spawn/skew/shutdown, watchers) | ROOT | remainder of `cloud/endpoint.ts`, `index.ts`; `DEFAULT_CLOUD_PORT` moves to `config.ts` |

New tool surface: `write_status`; `cloud_status` aggregate fields. Deleted
tool behavior: post-commit QuickSync + immediate re-export diff; the
`verified` boolean.

### Deletion list

| Deleted | Why |
|---|---|
| `cloud/log-projection.ts`, `cloud/structure-align.ts`, `cloud/snapshot-store.ts`, `cloud/snapshot-validate.ts` | mirror-as-projection dies; reads come from the export, authoring from the row store |
| `cloud/state.ts` (delta log, `adoptInitialBaseline`, `EndpointMismatchError`; its lock duplication dies with it) | no version-authoritative state to defend |
| `cloud/credential-lending.ts` (all of it), `/v1/upstream/*` routes, `endpoint.ts` lent calls (`refreshUpstream`/`commitUpstream`/`vendorHistory`), `UpstreamWriteSession` | no credential crosses the process seam; MLO is the sole vendor writer |
| `cloud/client.ts`, `/v1/pull\|push\|finalize` routes | second sync protocol, zero production callers |
| `mirror-blind.json` / `mirror-health.json` writes and reads | latches replaced by gauges |
| `tools/shared.ts` upstream arm of `resolveWriteChannel`, the `ctx.cloud`-absent downgrade branch | replaced by required services + `MloRepository.write` |
| Stale-write / unadvanced-commit refusal machinery | protected the endpoint's own uploads, which no longer exist |
| `Snapshot.xml`/`.guidCount`, task-tree/xml write residue, unused cursor helpers | c7 residue |

## 8. Test strategy

- **Two vitest projects only - `unit` and `mlo`** - as today. No CI (an
  implementation-effort decision this spec does not make).
- **The sabotage suite lives in `unit`, in-process**: instantiate the
  resident's handler stack directly, feed it a canned vendor session,
  fault-inject each subsystem in turn (capture throws, row store
  unreadable/gapped, queue corrupt, binding absent, every service broken),
  assert the full proxied sync completes with the vendor's payload intact.
- **Auto-init pull suite**: fault-inject each pull stage (pull, validate,
  ground-truth) and assert no binding is written on any partial failure.
- **Live items split by whether a human is required.** Unattended
  verify-live items run in `mlo` behind `MLO_LIVE=1` (they mutate the Demo
  profile and take minutes): the `GetFileTS` nudge inducing a session (and
  verbatim answers resuming when the queue empties), four-verb propagation,
  TTL expiry surfacing `expired` in `write_status` + the dead-letter
  aggregate. The conflict rounds (dialog held open, local-wins vs
  remote-wins, `write-superseded` discrimination) stay a **manual runbook**
  (tickets 05/13 harness recipe); only their machine-side halves are
  automated as fake transitions in `unit`.
- **Contract tests**: one shared parameterized suite per interface
  (`describeMloRepositoryContract(makeImpl)` style), run from `unit` against
  the fake always, and from `mlo` against the real implementation where no
  vendor traffic is needed. Typed refusal kinds and the problem+json seam
  shape (including unknown-kind degradation) are part of each suite, so fakes
  cannot drift.
- **Fake roster** (`test/fakes/`, never shipped in `src/`): `FakeMloCli`
  (scriptable exit codes; reproduces both CLI traps), `FakeResidentClient`
  (scriptable problem+json refusals by kind, incl. unknown),
  `FakeMloRepository` (in-memory tree + hand-driven five-state transitions,
  incl. conflict-skip: delivered-by-UID with differing content ->
  `superseded`, never `verified`; and stalled-session: Get seen, no Apply),
  row-store fake (miss -> typed `unknown-row` + `repull`), capture-journal
  fake, trivial binding/sightings/dead-letter fakes. Ticket 14's overlay
  semantics (four verbs, `pending` flags, silent drop on expiry/supersede)
  test against `FakeMloRepository`.

## 9. Migration plan

**Big-bang, dependency-ordered, no per-step test gates** (user decision).
During the migration the bar is typecheck/lint plus whatever unit tests still
compile. **The single acceptance bar at the end: all suites green - `unit`
(with sabotage + contract suites), `mlo`, and one `MLO_LIVE=1` pass.**

Dependency order (verified orderings: c2 before c1; c3 before c4; c6 rides
c2's struct change; the write side of c4/c5 is dead code, so both shrink to
read/status authority + the problem+json seam):

1. **Deletions first** (c7 + the section 7 deletion list): dead protocol,
   projection apparatus, credential lending, `/v1/upstream/*`. Move
   `DEFAULT_CLOUD_PORT` into `config.ts`. Shrinks every later diff.
2. **Repository seam** (c2): introduce `MloRepository` + the `MloCli` driver
   behind it; the ~150 untested write-verify lines become fake-testable.
3. **ToolContext to required-services-only** (c6, same struct change as 2):
   split `tools/shared.ts` into contract infra / OutlineService policy / DTO;
   delete the silent-downgrade branch.
4. **Identity service** (c1): one resolver, aligned against the row store;
   `guids.ts` becomes an injected cross-check.
5. **PartitionStore** (c3 reshaped): private layout; row store + capture
   journal + binding/sightings/dead-letter under the per-UID handle.
6. **The resident write path**: injection queue (durable accept), Get
   injection + bump, Apply observation with content compare, `GetFileTS`
   nudge, TTL expiry; `POST /v1/write` + `GET /v1/write/:id`. Mechanics from
   the prototype branch.
7. **Services** (07 roster): OutlineService (authoring from the row store),
   NextActionsService, ReviewService, AvailabilityEngine, AdminService with
   guarded auto-init.
8. **Error contract everywhere** (c5 finished): `ServiceResult` unions per
   boundary, problem+json seam, gauges, four-tier table with review gates.
9. **Tool surface**: accept-and-return write responses, `write_status`,
   `cloud_status` aggregate, read-your-own-writes overlay.
10. **Domain split** (c8: schema/guid/merge) - navigation-only, anytime,
    last.

Verify-live before the acceptance bar (the one decided-but-untested
mechanism): the `GetFileTS` nudge. Worst case MLO ignores the advanced
answer and delivery falls back to riding the next natural session - no worse
than today; if so, revisit delivery latency vs the 15-minute TTL.

## 10. Out of scope

- Local mode (`scripts/bootstrap-local.ts`) redesign - dev/test-only surface.
- CI - implementation-effort decision.
- A second sync client (phone) on the same data file - reopens the derived
  version namespace (held in reserve in the prototype) and the drift-skip
  safety question; see ADR-0005's options not taken.

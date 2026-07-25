# ADR-0003: The endpoint is a resident process; MCP sessions never own the listener

Status: accepted (2026-07-25), implemented (2026-07-25) — supersedes the
ownership model described in
[ADR-0002](0002-report-binding-mismatch-never-repair-it.md)

## Context

MLO reaches its vendor cloud through the app's HTTP proxy setting, pointed at
`127.0.0.1:8181`. That wiring is **permanent** — the app hardcodes the vendor
sync URL, so the proxy is how the endpoint exists at all, not a debugging aid
([mcp-cloud.md](../mcp-cloud.md)).

The listener, however, has been incidental. `startOrAttachCloudServer` tries to
bind the port once at startup; on `EADDRINUSE` it probes `/v1/status`, and if
another mlo-mcp answers it returns `undefined` and the process runs *attached*.
There is no takeover, no re-bind, no watchdog: whichever process binds first
holds the port for its whole life, and every later process is attached for its
whole life.

The install model makes concurrent processes the normal case rather than an edge
case. There is no per-project configuration — the server auto-detects the
profile MLO currently has open and follows it across switches — so it is
registered once at user scope and every agent session spawns one.

Three faults follow, and the first is the serious one:

1. **Closing the owning session breaks MLO's sync machine-wide.** The proxy
   still points at 8181, nothing listens there, and the surviving attached
   sessions do not take over. There is historical evidence consistent with this
   already: a dense run of endpoint-path failures on 20–23 July carrying WinINet
   `12029` (`ERROR_INTERNET_CANNOT_CONNECT`) — nothing answered on the port.
   That correlation is **a hypothesis, not a confirmed finding**; it has not been
   checked against session start/stop times.
2. **Only the owning process can write upstream.** Vendor contacts are captured
   strictly in the listening process's memory, so `requireWriteChannel` refuses
   everywhere else. Which agent session can write is decided by startup order and
   is invisible without asking `cloud_status`.
3. **Every server restart disarms writes** until MLO happens to sync through the
   new process, because the contact map starts empty.

ADR-0002 treated (2) as a diagnosis problem and made the role observable. That
was right as far as it went, but it documents the constraint rather than
removing it.

## Decision

**A resident endpoint owns the listener.** One long-lived process serves 8181
and outlives every MCP session. It is the only holder of vendor contacts and the
only performer of upstream sync sessions.

**MCP sessions never listen.** Startup becomes: probe, spawn the resident
endpoint detached if it is absent, then attach — always, on every path. The
`owner`/`attached` distinction stops being a lottery and becomes a health
question ("is the endpoint up?").

**It is auto-spawned, not installed.** The first session that finds the port free
spawns it detached; if it ever dies, the next session respawns it. This keeps the
README's "Node 22+ — that's all" promise intact and makes the arrangement
self-healing, which is what fixes fault (1).

**The forward seam is the upstream sync session only.** Attached processes ask
the resident endpoint for the vendor round trips that need a contact, and for
nothing else: refresh a mirror, commit delta bytes, and — settled while
implementing, see below — pull a full history for a bootstrap. Everything else
stays where it is: tools, mirror reads, and delta authoring all run in the MCP
process against the shared state root, exactly as today. The daemon lends
credentials; it does not execute tools.

**A newer session replaces a stale endpoint.** `/v1/status` reports the build;
a session running a newer version asks the resident process to exit, waits for
the port, and respawns. Older sessions attach quietly so a stale window never
downgrades a fresh endpoint.

**The commit route is unauthenticated.** Considered and declined (below).

## Options not taken

- **An explicit install step** (Scheduled Task at logon, or a service). The only
  option that closes the boot window, and rejected for install cost: it turns a
  zero-dependency README into one that asks for Windows-specific machinery.
- **Keeping bind-if-free, with handoff on exit.** Preserves the in-process fast
  path, but handoff at shutdown is the least reliable moment available — a
  crash, a kill, or a closed terminal skips it entirely, and those are exactly
  the cases that take the sync down.
- **Keeping bind-if-free, daemon only fills the gap.** Cheapest change, and a
  partial fix: whenever a session does own the port, its exit still leaves MLO
  pointing at a dead one.
- **Port takeover by attached processes.** Fixes the outage without a daemon,
  but leaves the contacts in one process's memory, so writes stay a lottery and
  a takeover starts cold.
- **Forwarding whole tool calls.** A stronger invariant — exactly one process
  ever authors a delta, and the refresh/author race closes — but "execute any
  tool" is a wide contract that must version-match, and stale resident processes
  are inherent to auto-spawning. A narrow refresh/commit contract survives skew;
  a tool-dispatch contract does not.
- **Moving everything into the daemon**, leaving MCP a stdio↔HTTP shim. Would
  also retire `mlo-cli.ts`'s cross-process lock directory and its 90s stale-lock
  timeout. Rejected as the largest refactor with the widest skew blast radius,
  and it makes reads — which work today with no endpoint at all — depend on one.
- **Persisting the vendor contact** so any process can open its own upstream
  session. By far the smallest change, and it writes the user's MLO Cloud login
  and password to disk, breaching an invariant the code states in capitals.
- **A shared token on the commit route.** Recommended and **declined by the
  owner (2026-07-25)**. Recorded so it is neither quietly added nor assumed to
  be present: `/v1/commit` lends stored vendor credentials to any caller, and
  loopback on Windows is reachable by every account on the machine, not just the
  one that owns the endpoint. The mitigation considered was a random value
  written to the state root and required as a header — roughly fifteen lines,
  defending against other local accounts and service identities but not against
  malware running as the user. The decision was that loopback is sufficient.
  Reversing it is cheap; the docs must state plainly that any local account can
  drive writes through the endpoint.
- **Contract-only versioning**, accepting any build that serves a compatible
  refresh/commit API. Robust against release churn and blind to the skew that
  actually hurts: a pre-0.3 endpoint records no unbound sightings, so ADR-0002's
  mismatch detection silently stops working without the contract changing.
- **An idle timeout on the resident process.** "Idle" is the wrong signal — MLO
  syncs through this port whether or not any agent is attached, so the timer
  either kills a listener in active use or never fires.

## Consequences

- MLO's sync survives agent sessions starting and stopping, which is the defect
  this record exists to fix. **The boot window remains open**: MLO launching and
  syncing before any agent has run since boot still finds nothing listening.
  That is a failed sync MLO retries, not data loss, and it is the accepted price
  of auto-spawn over an install step.
- Writes work from every session, so ADR-0002's "run this from the client that
  owns the endpoint" refusal, the `endpointRole` lottery, and "one proxied sync
  per server restart" all stop being things a user has to reason about. The
  contacts now outlive sessions, so one proxied sync warms writes until the
  resident process exits.
- `cloud_status` changes meaning: `endpointRole` is gone, replaced by
  `endpoint { url, reachable, version }` — a health question, not a role this
  process won or lost. The old name could not have been kept honestly; nothing
  about it was true any more.
- Every write pays a loopback hop even when only one session exists, and startup
  pays a spawn-and-wait when the endpoint is absent. A resident process that
  fails to start is a new failure mode with no equivalent today.
- **`cloud_bootstrap` is not covered by the narrow seam.** It reaches for
  `vendorContact()` and `vendorContactUids()` directly, so under "sessions never
  hold contacts" it breaks unless it forwards too or runs in the resident
  process. **Settled while implementing:** it forwards, as a third
  credential-lending operation rather than as a tool. The resident pulls the
  vendor's full history; validation, materialization and the binding stay in the
  session, which is the only side that knows the profile path. The alternative —
  running the whole bootstrap in the resident — was rejected for crossing the
  line this record draws: it would have made the daemon execute a tool, and the
  profile path is session knowledge with no business in a process that serves
  every profile at once. `vendorContactUids()` is exposed as `contactUids` on
  `/v1/status`, which is an inventory of cloud files, not credentials.
- Splitting refresh (resident) from authoring (session) across a process
  boundary **widens the window** in which a mobile or vendor edit can land
  between the two. The window exists today within one process; the ordering of
  the two round trips needs settling in the spec. **Settled while
  implementing:** the resident holds one vendor session across both calls (so
  the wire behaviour is unchanged from the in-process version) and returns the
  mirror cursor the author is entitled to assume. At commit it re-checks that
  cursor; if the mirror moved, nothing is uploaded and the caller is told to
  retry. The mirror only advances on real content, so the check fires exactly
  when a full-row rewrite would otherwise have clobbered a concurrent edit —
  turning today's silent lost update into a visible, retryable refusal. The
  price is a spurious-looking refusal when an unrelated change lands mid-write;
  that is the same trade ADR-0002 already made for binding mismatches.
- An unauthenticated commit route means any local account can write to the
  user's cloud data through the endpoint. Deliberate; see above.

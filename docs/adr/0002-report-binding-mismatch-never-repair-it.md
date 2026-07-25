# ADR-0002: A binding mismatch is reported and refused, never repaired automatically

Status: accepted (2026-07-25)

## Context

The endpoint routes every SOAP sync by the `dataFileUID` in the request. A UID
with no binding takes the deliberate "stay out of the way" branch: forwarded to
the vendor Cloud unchanged, nothing captured, the local delta log never
consulted. That branch exists so the server never interferes with profiles it
was not asked to manage, and it is correct.

The failure it hides is not. When the **bound** profile starts syncing under a
different `dataFileUID` — a Re-synchronize, a restored `.ml` file, a new cloud
file, or a local-mode profile that reached the vendor — it becomes
indistinguishable from a profile the server was never asked to manage. MCP
writes keep queueing into the bound partition, which nothing will ever read.

Observed live: four `add_task` calls returned `verified: false` (documented to
mean "accepted, not applied yet"), MLO's own sync reported success 16/16 times,
and `cloud_status` reported `lifecycle: ready` with a healthy cursor throughout.
The cause was found only by reading MLO's private sync log and diffing a GUID by
hand. `cloud_status` could not reveal it because it sources the UID from the
binding: it is self-consistent by construction, faithfully reporting the
identity of a partition that had been abandoned.

A second, independent gap made diagnosis harder. The endpoint is a singleton on
the loopback port — the first server process owns the listener, later ones
attach without one — and vendor contacts are captured strictly in the *owning*
process's memory. The same tool call therefore succeeds from one MCP client and
fails from another, with nothing indicating which role the current process
holds.

## Decision

**The authority decision records what it sees.** When a sync resolves to the
unknown-UID branch, the observed UID and a timestamp are persisted into the
state root (`unbound-sightings.json`) beside the existing endpoint-health
markers. Routing, capture, and the response returned to MLO are unchanged.
Persistence — not the in-memory contact map — is what makes the fault visible
to attached processes and across restarts.

**A sighting is a mismatch only against a bound profile.** The flag is raised
when the configured profile has a binding whose UID differs from an observed
one. A profile with no binding at all is first-run setup, not drift, so a
genuinely foreign profile stays silent and the "stay out of the way" guarantee
holds.

**Writes are gated in the shared tool path**, before any delta is built or
queued, so every current and future write tool inherits the refusal. The
refusal names both UIDs, the profile, and the remedy — a refusal an agent must
handle beats a success message it will believe. Reads are unaffected: a user
can still inspect the tree while sorting the binding out.

**`cloud_status` answers the question directly**: the bound UID keeps its
meaning and its source, and the observed UID(s) and a `bindingMismatch` boolean
are reported beside it. *(The endpoint role `owner` / `attached` was reported
here too. [ADR-0003](0003-resident-endpoint.md) removed the role — every session
now attaches — and replaced the field with `endpoint { url, reachable,
version }`.)*

**Bootstrap checks its preconditions before the binding moves.** The rebind
path used to replace the binding and only then discover it had no vendor
contact, leaving a half-repaired state that is harder to recover from than the
original fault.

**No automatic repair.** Rebinding changes which authority owns a profile's
history, and switching sync authorities is documented as unrecoverable
([cloud-sync.md](../mlo/cloud-sync.md#switching-endpoints-is-not-a-reconnect)).
The server reports precisely and refuses to guess; the choice stays with the
human.

## Options not taken

- **Auto-rebinding to the observed UID.** It is the obvious repair and it is
  unrecoverable when wrong — a mobile device or a second profile syncing
  through the same proxy would be enough to make it wrong.
- **Expiring the mismatch after a quiet period.** Tried, then removed. It would
  let a foreign profile's one-off sighting age out instead of refusing writes
  forever with no tool to clear it — but it also re-opens the defect: a
  drifted profile that simply goes unsynced for a day (MLO closed overnight,
  or the user pausing sync while investigating) would start silently accepting
  writes into the abandoned partition again. Refusing wrongly is recoverable;
  accepting silently is the thing this record exists to prevent. A binding a
  foreign sighting is blocking is cleared the same way every other repair
  happens here — by hand, by deleting `unbound-sightings.json` from the state
  root, which is why the marker's location is documented.
- **Surfacing the fault only in the log.** That is what the code did: one
  stderr line nobody reads, invisible to the one tool a user or agent naturally
  reaches for.
- **Making `lastPull` staleness the signal.** A `lastPull` frozen while syncs
  keep succeeding is what proved the diagnosis after the fact, and it is a
  genuinely independent second signal worth adding. It is derived evidence
  though; the observed UID is the fault itself.

## Consequences

- A write into a mismatched binding fails loudly on the first attempt instead of
  reporting queued success four times, and nothing is queued — so a later
  repair does not replay a forgotten backlog.
- `cloud_status` stays a single call that answers "is this working", and
  answers it correctly when it is not.
- "Run this from the client that owns the endpoint" becomes checkable rather
  than folklore.
- A user running two MCP clients gets a bootstrap refusal that explains the
  ownership constraint instead of "no vendor sync traffic observed since server
  start", which reads like a broken install.

  *(Both of the above were made moot rather than wrong by
  [ADR-0003](0003-resident-endpoint.md): with one resident endpoint and no
  session-owned listeners, there is no client to run things "from". The
  equivalent refusal today is "the resident endpoint is not reachable".)*
- The state root gains one more marker file, `unbound-sightings.json`. It
  follows the shape of `mirror-blind.json` / `mirror-health.json` rather than
  introducing a second convention for the same idea, and keeps only the eight
  most recently seen UIDs — it is a diagnostic marker, not a log.
- A second profile that syncs through the same proxy while this one is bound
  raises the mismatch too, and there is no tool to dismiss it: the only
  automatic clearing is the observed UID becoming bound. That is the deliberate
  direction of the trade — the manual escape is deleting the marker file.

# ADR-0007: Sync drift is recovered from automatically, not reported and refused

Status: accepted (2026-08-01)

Reverses: [ADR-0002](0002-report-binding-mismatch-never-repair-it.md) ("a binding
mismatch is reported and refused, never repaired automatically")

## Context

A binding is keyed by profile path. A `dataFileUID` identifies the cloud file.
When the `.ml` at a bound path is re-created — restored from backup, rebuilt by
MLO, a reset sync profile, a Re-synchronize — the path survives and the identity
it pointed at does not. The binding then names a `dataFileUID` that nothing will
ever sync again. This is **identity drift** — qualified, because
[docs/mcp-cloud.md](../mcp-cloud.md) already uses bare "drift" for MLO syncing
behind the endpoint's back with the proxy off, which is not an error at all.

Everything downstream keeps working perfectly against the abandoned partition,
and that is the whole problem:

- writes are authored, queued, and return an accept receipt with a `writeId`;
- reads overlay the queue and show the task flagged `pending: true`;
- `sync` returns `{ok: true}`; every proxied exchange is HTTP 200, because
  `GetModificationsBytesEx` arrives under the *new* UID, finds no partition, and
  is forwarded verbatim — exactly as designed for a profile the server was never
  asked to manage;
- 15 minutes later the queued rows hit their TTL and dead-letter as `expired`.

Observed live on 2026-08-01, and this is the second recorded instance of the same
shape. `cloud_status` reported `bindingMismatch: true` with two pending writes
and one already dead-lettered; the profile at `D:\dev\demo\demo-profile.ml` had
`CreationTime == LastWriteTime == 14:41:21Z`, matching the new UID's `lastSeen`
to the second. Diagnosis took an hour of reading MLO's private sync log and
comparing GUIDs by hand, and the repair was a hand-edit of `bindings.json` and a
partition's `meta.json`.

ADR-0002 saw this fault and chose to make it loud: report the mismatch, gate
every write on it, and leave the repair to a human, on the reasoning that
*"refusing wrongly is recoverable; accepting silently is the thing this record
exists to prevent."* Two things about how that played out:

1. **Only half of it shipped.** The reporting landed; the write gate never did.
   `error-contract.ts` has carried `binding-mismatch` as a declared-but-never-
   produced write-gate kind since. So in practice the fault has been silent all
   along — ADR-0002's actual promise, that a mismatched write "fails loudly on
   the first attempt instead of reporting queued success four times, and nothing
   is queued", has never been true in a shipped build.
2. **Refusing is not as cheap as it looked.** A refusal ends the incident only
   for someone willing to hand-edit JSON in a private state root. For the user,
   a refusal and a silent loss are the same event — MLO does not do what they
   asked — differing only in whether they also lose the afternoon.

The user's instruction, given three times and after being shown the wrong-bind
risk below: *"if there is unrecoverable error in sync — broken envelope, profile
mismatch, mars attack — start fresh."*

## Decision

**On drift, the endpoint discards and re-adopts.** When guarded
auto-initialization finds the running app's open profile already bound to one
`dataFileUID` while an unclaimed candidate is syncing, it deletes the abandoned
partition, releases the binding, and binds the identity MLO actually presents.
No tool to call, no refusal to read.

**What used to be three blocking guards is one guard and two recoveries.**

| Situation | ADR-0002 | ADR-0007 |
| --- | --- | --- |
| Profile already bound, another UID syncing | refuse `binding-conflict` | **recover**: discard partition + queue, adopt the live UID |
| More than one unbound candidate | refuse `ambiguous-bootstrap-candidate` | **choose**: the most recently sighted |
| Candidate fails ground-truthing | refuse `candidate-not-ground-truthed` | **warn**: journal it as `failed`, bind anyway |
| No candidate at all | refuse `no-bootstrap-candidate` | unchanged — **still refuses** |

The last row is not an exception, it is the ordering constraint. Recovery runs
only with a candidate in hand. An endpoint that has seen no traffic (MLO closed,
or the resident just restarted) reaches that point holding a perfectly good
binding, and discarding it there would destroy a healthy partition with nothing
to adopt in its place. A test asserts the binding survives it.

**Discarded writes are discarded silently.** Not dead-lettered, not replayed, not
surfaced. Replay is not merely declined but mechanically wrong: `update_task` and
`complete_task` author from the row store, and recovery fires precisely because
that row store describes a data file that no longer exists. Silence is the
user's explicit choice, made after being offered dead-lettering.

**`bindingMismatch` stays in `cloud_status`.** Drift should now be transient, so
the field becomes a way to see recovery not having happened yet, rather than a
standing fault. `binding-mismatch` and `ambiguous-bootstrap-candidate` stay
declared in the error contract, unproduced, so the tier tables stay complete.

**Ordering is unchanged and load-bearing.** The destructive step goes first and
the pointer moves last: a crash mid-recovery leaves a binding pointing at a
partition that is already gone, which reads as an unbound profile and re-recovers
on the next sync. The reverse order would leave a stale partition to be adopted
twice. Tested.

## The trade, stated plainly

This re-opens the hazard ADR-0002's guards existed to close, and the known way it
bites is on the machine where the motivating incident happened: a second copy of
the same profile exists at `D:\dev\projects\demo\demo-profile.ml`. If that copy
ever opens and syncs through the same proxy, recovery can adopt it, and writes
land in the wrong profile with no signal. Ground-truthing does not save this
case — two copies of one outline share task GUIDs, so it ground-truths clean
against either. Choosing the most recently sighted candidate is a heuristic about
which file is live, not a proof.

ADR-0002 called auto-rebinding "unrecoverable when wrong". That has not been
refuted; it has been accepted, knowingly, in exchange for a server that does not
sit broken. A single-machine, single-profile, no-mobile-device setup — the one
this build is used in — makes it rare. It is written here so that when it happens
it is diagnosed in minutes instead of rediscovered.

The retained ground-truth check is the residual protection: it still runs, and a
refutation is recorded in the partition journal as `failed` with
`GROUND-TRUTH REFUTED` and logged as `WARNING`. It no longer blocks, but it is
the first thing to read when a profile's contents look wrong.

## Options not taken

- **An explicit `reset` tool named by the refusal's remedy.** One call instead of
  an hour of forensics, without reversing ADR-0002's core trade. Rejected by the
  user: MCP should not stop and ask.
- **Auto-recover only when it cannot be wrong** (single sighting, no other
  candidate profile). Preserves the guarantee in the common case and refuses only
  in the genuinely ambiguous one. Rejected as a carve-out.
- **Dead-lettering the discarded queue.** The raw text of dropped writes appended
  to the existing dead-letter file, plus an advisory on the next call. Cheap, and
  the difference between "MLO ate my folder" and a list of what was dropped.
  Rejected by the user in favour of silence.
- **Finally building ADR-0002's write gate.** Superseded rather than rejected:
  with recovery automatic, there is no standing mismatch left for a gate to
  refuse on.

## Consequences

- Drift self-heals on the next proxied sync. The 2026-08-01 incident would have
  cost one sync instead of an hour, at the price of two silently dropped writes.
- Recovery is destructive and silent by design. `cloud_status` will show a clean
  binding afterwards, and nothing will say what the queue held. The endpoint's
  stderr log and the partition journal are the only trace.
- Adopting the wrong cloud file is now possible. See the trade above.
- `AdminService.rebind` remains the explicit path; it is no longer the *only*
  way a binding moves, which is what ADR-0002 relied on.
- Two error-contract kinds are now declared and never produced, joining
  `binding-mismatch`, which already was.

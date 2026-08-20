# ADR-0009: Write tools hold their reply open for a bounded delivery wait

Status: accepted (2026-08-20)

## Context

The write contract (spec section 2, ADR-0005) returned at durable accept:
"accepted - lands on MLO's next sync". Interactively, that reads as "not done
yet" - the user completes a task and is told to wait for a sync, even though
the after-accept QuickSync nudge usually lands the change in MLO's UI within
~13 s. The contract argued a waiting tool "would either lie (timeout reported
as failure) or block the caller for MLO's ~90 s cadence" - but that dichotomy
ignored a third option: wait a bounded window and report whatever status the
window closed on, honestly.

## Decision

1. **`OutlineService.commit` waits after accept.** Once a write is durably
   accepted (and the existing nudge fired), the service polls `write_status`
   every second for up to `writeWaitMs` (default 20 s, `MLO_WRITE_WAIT_MS`
   overrides, `0` restores return-at-accept). The wait is pure observation:
   it never blocks the accept, never converts a timeout into a failure, and a
   status poll that refuses simply ends the wait.
2. **The receipt carries the observed outcome.** `AcceptReceipt.outcome` (and
   the tool-facing `status` field) is now the five-state write status as of
   window close: `delivered`/`verified` say "applied and visible in MLO now",
   `accepted` keeps the old wording (queued, rides MLO's own sync, reads show
   it flagged pending), `superseded` says the conflict out loud with the
   re-read remedy.
3. **Delivery mechanics are unchanged.** The injection queue, the budget-gated
   QuickSync nudge, the GetFileTS nudge, TTL/dead-letter, and `write_status`
   all stand as ADR-0005 specified. When MLO's QuickSync throttle budget is
   spent, the wait times out and the receipt honestly says `accepted`.

## Consequences

- An interactive write typically answers "delivered - visible in MLO now"
  after ~13 s instead of instantly promising a future sync.
- Throughput-sensitive callers (batch scripts) set `MLO_WRITE_WAIT_MS=0`.
- The error-contract guard's setTimeout allowlist gains
  `src/services/outline.ts`: the delivery wait paces a success path, it is not
  a retry after a typed failure.

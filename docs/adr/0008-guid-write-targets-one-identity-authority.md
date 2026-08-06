# ADR-0008: Writes target by GUID, identity is stamped once, and accepted rows are captured at accept

Status: accepted (2026-08-07)

## Context

A live session (`.scratch`-triaged as the write-targeting batch) hit three
compounding failures in one routine add-then-move-then-date flow:

- **Silent wrong-target writes.** Path ids were the only write-targeting
  mechanism. A queued structural write (a move) leaves the export tree behind
  the caller's mental model, so a computed path id re-resolved to an unrelated
  task — and the write was *accepted* against it, corrupting a task nobody
  meant to touch. Every response already carried the stable GUID; no input
  accepted one.
- **Reads disagreed about identity.** Three code paths each picked their own
  identity source: the pending overlay paired queued rows to export tasks by
  the binary `.ml` annotation only (flaky by design), list/search summaries
  reported that annotation as `Guid`, and `get_task` reported the snapshot
  resolver's alignment answer. Result: queued updates invisible in reads,
  a queued move showing the same task twice, `Guid` flapping between tools.
- **A fresh add was not writable.** Authored rows entered the row store only
  at injection time, so add-then-move always cost a `target-unresolvable`
  error plus a sync round trip.

## Decision

1. **Every write target accepts the stable GUID in brace form** (`id` of
   update/move/complete/uncomplete/delete, and `move_task`'s `newParentId`).
   Brace form is never reinterpreted as a path id; an unknown GUID refuses
   `target-unresolvable`. Every write accept echoes the resolved task's
   `caption` (text and structured), so a wrong-target resolution is visible in
   the accept instead of silent.
2. **One identity authority, stamped at snapshot build.** `stampIdentity`
   (domain-tier `structure-align.ts`) writes the ladder's answer — structural
   alignment against the row store first, binary annotation as fallback — onto
   each task's `Guid` on the raw export, before the pending overlay composes.
   The overlay pairs by that stamp (in-place pending updates, no phantom
   duplicates), and every read tool reports it.
3. **Accepted rows enter the row store at durable accept** (source
   `injected`), which makes a fresh add immediately writable. Two guards keep
   that honest: rows whose only provenance is injection stay out of structural
   alignment until MLO is observed holding the task (`alignsFromStore`), and
   they are discarded when their write expires (`discardNeverApplied`) so a
   task MLO will never hold stops resolving as a writable target.

## Consequences

- The incident's flow — add, search, move, set dates — runs with zero errors
  and no explicit sync, targetable by GUID throughout.
- `docs/tools.md`'s "every tool input takes a Path id; GUIDs appear in output
  only" no longer holds and was rewritten; the accept shape gained `caption`.
- The read-your-own-writes promise is now true in place for any task the
  ladder can resolve; the residual case (identity unresolvable → the queued
  change shows as its own pending row) is named in the server instructions.
- The row store's `source` is no longer pure evidence: the `injected` family
  gates alignment membership and expiry cleanup.

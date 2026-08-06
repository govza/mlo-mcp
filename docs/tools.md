# MCP tool surface

What each of the server's tools is *for* and what it guarantees. Exact
parameter schemas are **generated from the registry** and deliberately not
duplicated here — run:

```
pnpm tools               # every tool, grouped by kind
pnpm tools add_task      # full schema for one tool
pnpm tools --json        # the catalog as JSON
```

(`scripts/tool-catalog.ts`, kept in lockstep with `src/tools/registry.ts` by
`tool-catalog.test.ts`.) This document defines semantics; the catalog defines
shapes. If they ever disagree on a shape, the catalog is right.

## Shared semantics

- **Ids are path-based** (`"1.2.3"` = position in the tree) and shift whenever
  the tree changes. They are valid only for immediate follow-up calls; after
  any write, re-run `list_tasks`/`search_tasks`. GUIDs (`{…}`) are the stable
  identity, resolved by aligning the fresh export against the **row store** —
  the full task rows the endpoint captured from MLO's own sync traffic — with
  the binary `.ml` GUID recovery as the cross-check. A task the row store has
  seen resolves `confirmed` and can be authored against; one recovered only
  from the binary resolves `unconfirmed`, and a write against it refuses with
  the `repull` remedy. Read tool inputs take a **Path id**; write targets
  (update/move/complete/uncomplete/delete, and `move_task`'s `newParentId`)
  also accept the stable GUID in brace form — a GUID names its task however
  the tree has shifted, and is never reinterpreted as a path id
  ([ADR-0008](adr/0008-guid-write-targets-one-identity-authority.md)). Reads
  and write receipts return GUIDs (`get_task` reports one when recoverable).
- **Writes never touch the data file.** Every write travels as a complete
  sync delta ([mcp-cloud.md](mcp-cloud.md)) that MLO's **own** merge logic
  applies, with the app still running.
- **Writes return at durable accept, and nothing waits.** A write tool answers
  `{ uid, caption, writeId, status: "accepted", expiresAt, message }` as soon as
  the rows are fsync'd into the resident's injection queue — `caption` names the
  task the target resolved to, the tell that catches a stale path id landing on
  the wrong task. There is no `verified`
  boolean and no post-write export diff: MLO applies the rows on its own next
  sync (about 90 s, or immediately on `sync`), and an accepted write that has
  not landed within its TTL (default 15 minutes) expires into the dead-letter
  file rather than being retried forever.
- **`write_status(writeId)` is where the outcome lives.** Five states:
  `accepted | delivered | verified | expired | superseded`. `expired` means
  nothing was applied; `superseded` means MLO applied its own conflicting
  version of the same task, so this write's content is gone. Both carry a
  remedy. Receipts age out of the resident's outcome ring.
- **Reads show your own writes.** `list_tasks`/`search_tasks`/`get_task`
  compose the pending queue onto the fresh export at read time: an add appears
  as a phantom task, an update merged, a completion completed, a delete hidden.
  A pending `move_task` shows the task under its new parent (last among its new
  siblings — slot order is not recoverable against an export tree). Overlaid
  tasks carry `pending: true` and the `writeId`. When a write leaves the queue,
  or its TTL passes, the entry simply disappears — expiry and supersede are
  announced by `write_status` and `cloud_status`, never by a read.
- **Batches are atomic.** `add_tasks` sends the whole batch as ONE delta; one
  bad entry and nothing is queued.
- **Writes need a bound partition.** MLO merges a changed task as a full
  82-column record, which the XML export cannot supply, so update/complete
  author from the rows the endpoint captured for the bound `dataFileUID`. Until
  one proxied MLO sync has bound the profile every write refuses
  `partition-not-ready`; a task whose row the store has never seen refuses
  `unknown-row`, whose remedy is a repull.
- **A binding mismatch refuses writes.** If MLO starts syncing a different
  `dataFileUID` than the profile is bound to, deltas would queue into a
  partition the app never reads. Mutation tools refuse before queueing
  anything, naming both UIDs and the remedy; reads are unaffected. Retrying
  cannot help — see
  [mcp-cloud.md](mcp-cloud.md#when-the-app-syncs-a-uid-the-server-does-not-manage).

## Read tools

- **`list_tasks`** — the task tree (or a subtree) as an indented outline plus
  structured summaries; completed tasks hidden by default; capped at 200
  unless overridden.
- **`search_tasks`** — flat filtered search: text over caption+note, context,
  due-date range, starred/completed/project, flag, minimum importance.
- **`get_task`** — everything recoverable about one task: note, estimates,
  schedule and recurrence-relevant fields, dependencies (both directions),
  children, GUID when recoverable.
- **`list_contexts`** — the profile's contexts (MLO Places, `@Office`-style)
  with usage counts.
- **`write_status`** — where one accept receipt got to, by `writeId`: the five
  states above, each with a detail sentence and, where anything ends the state,
  a remedy.
- **`cloud_status`** — binding (`dataFileUID`, mode), partition lifecycle and
  inventory, whether the resident sync endpoint is reachable and at what build
  (`endpoint`), whether MLO is syncing a different `dataFileUID` than the bound
  one (`bindingMismatch`, `unboundSightings` — see
  [mcp-cloud.md](mcp-cloud.md#when-the-app-syncs-a-uid-the-server-does-not-manage)),
  and the write aggregate (`writes`): queue depth, the oldest queued write's
  age, whether delivery is stalled on a session MLO is holding open over the
  writes — in practice a conflict dialog awaiting the user (`sessionHeldOpen`) —
  and the recent dead letters with uid, caption and reason. That last field is
  the only surface for a write nobody was waiting on — a `writeId` receipt dies
  with the MCP session that took it.

## Write tools

All return at durable accept (see Shared semantics); none waits on MLO.

- **`capture_task`** — rapid entry: one line in, one task in MLO's `<Inbox>`
  out (top level when the profile has none). Trailing `@context` tokens name
  contexts and text after a blank line becomes the note; dates and importance
  are NOT parsed — pass those through `add_task`.
- **`add_task`** — one task, emitted as a full fresh row; parent by Path id
  (`parentId`) or top level when omitted. Supports Folder, Project, Starred,
  visibility/sequential booleans, an existing Flag, existing contexts
  (`Places`), and dependencies on existing tasks.
- **`add_tasks`** — 1–50 new tasks in ONE atomic delta. Each entry may carry a
  batch-local `key`; `parentKey` builds arbitrary nested outlines and
  `dependsOnKeys` links tasks that do not exist yet. `parentId`/`dependsOnIds`
  link to tasks that do.
- **`update_task`** — field edits on one task (caption, note, dates,
  importance/effort/estimates, project status, goal), the Organize flags
  (`IsProject`, `Folder`, `HideInToDo`, `CompleteSubTasksInOrder`), Starred, an
  existing Flag, complete context replacement, and complete dependency
  replacement (`dependsOnIds`). Only the fields passed change; `""` clears a
  text field. Date edits on recurring tasks are refused (the series would
  desync).
- **`complete_task` / `uncomplete_task`** — set/clear `CompletionDateTime`
  (projects also flip `ProjectStatus`). Completing a recurring task is refused:
  in MLO that spawns the next occurrence, and a full-row rewrite would silently
  end the series instead.
- **`move_task`** — re-parent one task with its whole subtree, optionally into a
  slot among its new siblings. Moving a task into its own subtree is refused.
- **`delete_task`** — tombstones the task *and its whole subtree*; every task in
  the branch must resolve to its stable UID, else nothing is queued. MLO's own
  recycle bin is the only undo.
- **`sync`** — run MLO QuickSync on demand. Never load-bearing: it opens no
  session at all when MLO believes nothing changed, and what actually delivers a
  pending write is MLO's own sync cadence (which the endpoint nudges when the
  queue is non-empty). No write fires it.

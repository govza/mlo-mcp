# MCP tool surface

What each of the server's tools is *for*, what it guarantees, and how the
native and cloud variants relate. Exact parameter schemas are **generated from
the registry** and deliberately not duplicated here — run:

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
  identity but are recovered best-effort from the `.ml` binary and the XML
  export, so a task may have none.
- **Writes are batched and atomic.** Every batch-capable write tool applies
  its whole batch (an `ids` / `tasks` / `updates` array) in one operation; one
  bad entry means nothing changes. Batch instead of looping.
- **Two write pipelines** (the reason most write tools exist twice):

| | Native (`add_task`, `update_task`, …) | Cloud (`cloud_*`) |
|---|---|---|
| Mechanism | Rewrite the `.ml` file: export → mutate XML → convert → swap ([server-architecture.md](server-architecture.md)) | Append a delta to the local sync log, trigger QuickSync, MLO's own merge applies it ([mcp-cloud.md](mcp-cloud.md)) |
| MLO GUI | Closed and relaunched around every write | Keeps running |
| Safety net | Timestamped `.bak` next to the data file; verification failure auto-restores it | Delta stays queued; MLO merges it (this is the sync path MLO itself uses) |
| Failure mode | Refused/rolled back — data file untouched | Queued but unverified — applied on a later sync session |
| Coverage | Any task | Tasks whose identity (and for edits, full record) the cloud path knows — see below |

- **Cloud verification is advisory.** Cloud tools return `verified: true` only
  when a fresh post-QuickSync export confirms the change. `verified: false`
  does not mean failure — the delta is durably queued and MLO applies it on
  the next sync session.
- **Cloud edit coverage grows with the delta log.** MLO merges a changed task
  as a full 82-column record, and the XML export cannot supply one, so
  `cloud_update_task`/`cloud_complete_task`/`cloud_uncomplete_task` source the
  row from the delta log: a task is editable once it was added by a cloud tool
  or touched in MLO since the local endpoint took over. Everything else fails
  atomically toward the native tool.

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
  with usage counts; run before assigning contexts so existing ones are
  reused.
- **`cloud_status`** — read-only mirror of the local endpoint's
  `GET /v1/status`: cursor, per-origin delta counts, pending entries.

## Native write tools

All go through the file-replacement pipeline above: backup kept, GUI
restarted, verified against a re-export, restored on verification failure.

- **`add_task`** — create up to 25 tasks in one write, each optionally with a
  whole subtree outline; natural-language dates/urgency via MLO's rapid-entry
  parser (single-task mode); no `parentId` files into the `<Inbox>` node.
- **`update_task`** — per-task field edits (caption, note, dates, importance,
  effort, estimates, booleans, flag, contexts, goal), re-parenting moves, and
  dependency rewiring; up to 25 entries in one write.
- **`complete_task` / `uncomplete_task`** — set/clear `CompletionDateTime`
  (projects also flip `ProjectStatus`).
- **`delete_task`** — permanently delete tasks and their subtrees.
- **`sync`** — run MLO QuickSync for the profile as configured (this is also
  what every cloud write triggers internally).

## Cloud write tools

All follow queue → QuickSync → verify and never touch the data file directly.
See [mcp-cloud.md](mcp-cloud.md) for the delta/envelope details behind each.

- **`cloud_add_task`** — one task per call, full fresh row; parent by GUID
  (`parentUid`), not path id. The original vertical slice — batching and
  path-based parents are still native-only.
- **`cloud_update_task`** — batched field edits and re-parenting over logged
  full rows. Unsupported until their wire encoding is observed: booleans,
  flag, contexts, dependencies. Refuses date edits on recurring tasks.
- **`cloud_complete_task` / `cloud_uncomplete_task`** — completion over logged
  full rows; completing recurring tasks is refused (a row rewrite would skip
  MLO's next-occurrence generation).
- **`cloud_delete_task`** — tombstones each selected task *and its whole
  subtree* (cascade behavior of a bare parent tombstone is unverified); needs
  recoverable GUIDs for the whole subtree, else fails toward `delete_task`.

## Choosing a variant

Prefer the cloud variant when the MLO GUI is likely open (no restart, no file
swap) and the task is within cloud coverage; the tool fails atomically with a
pointer to the native fallback when it is not. Prefer the native variant for
bulk restructuring, fields the cloud path does not support yet, or tasks
without recoverable GUIDs. Mixing is safe — both paths converge on the same
profile through MLO's own load/merge logic.

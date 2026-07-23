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
  identity, resolved by STRUCTURAL alignment of the fresh export outline
  against the bootstrapped cloud tree (`UID`/`ParentUID`/`ItemIndex`) — so
  duplicate sibling captions resolve by position; the binary `.ml` recovery
  and the caption-path walk are cross-checks only. `add_task` takes a parent
  **GUID** (`parentUid`, from `get_task`), not a path id.
- **Writes never touch the data file.** Every write travels as a complete
  sync delta ([mcp-cloud.md](mcp-cloud.md)): normally committed to the real
  vendor Cloud in the endpoint's own sync session and delivered to MLO by the
  triggered QuickSync; MLO's **own** merge logic applies it, and the app
  keeps running.
- **Verification is advisory.** Write results carry `verified: true` only when
  a fresh post-QuickSync export confirms the change. `verified: false` does
  not mean failure — the delta is durably queued and MLO applies it on the
  next sync session.
- **Batches are atomic.** Batch tools (`ids`/`updates` arrays) send the whole
  batch as ONE delta; one bad entry and nothing is queued.
- **A one-time bootstrap enables writes.** MLO merges a changed task as a
  full 82-column record, and the XML export cannot supply one, so the edit
  tools source rows from the bootstrapped baseline (`cloud_bootstrap` pulls
  the vendor cloud's complete history) plus later deltas. Every pre-existing
  task is editable after bootstrap; before it, mutation tools fail atomically
  with a pointer to the bootstrap procedure. Back up the `.ml` profile before
  the first bootstrap.

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
- **`cloud_status`** — binding (`dataFileUID`, mode), bootstrap lifecycle,
  cursor and per-origin delta counts, last local stamp, endpoint-mismatch
  count, partition inventory, and mirror coverage/health.

## Write tools

All follow commit → QuickSync → verify. See [mcp-cloud.md](mcp-cloud.md) for
the delta/envelope details behind each.

- **`cloud_bootstrap`** — the one-time setup: after one ordinary MLO sync
  through the proxy, pulls the vendor cloud's full history, validates and
  materializes it, and binds the profile; reads and writes are live
  afterwards. `rebind: true` starts a fresh partition explicitly.

- **`add_task`** — one task per call, emitted as a full fresh row; parent by
  GUID (`parentUid`) or top level when omitted. Supports Folder, Project,
  Starred, visibility/sequential booleans, an existing Flag, and existing
  contexts (`Places`), plus dependencies by stable GUID.
- **`add_tasks`** — 1–50 new tasks in ONE atomic delta. Each entry has a local
  `key`; `parentKey` creates arbitrary nested outlines and `dependsOnKeys`
  creates dependencies within the new batch. `parentUid`/`dependsOnUids` link
  to existing tasks.
- **`update_task`** — batched field edits (caption, note, dates,
  importance/effort/estimates, project status, goal), Folder/Project/Starred
  and other task booleans, existing Flag assignment, complete context
  replacement, complete dependency replacement (`dependsOnIds`), and
  re-parenting moves over logged full rows. Date edits on recurring tasks are
  refused (the series would desync).
- **`complete_task` / `uncomplete_task`** — set/clear `CompletionDateTime`
  (projects also flip `ProjectStatus`) over logged full rows. Completing
  recurring tasks is refused — completing them in MLO generates the next
  occurrence, a full-row rewrite would not.
- **`delete_task`** — tombstones each selected task *and its whole subtree*
  (cascade behavior of a bare parent tombstone is unverified; extra
  tombstones union-merge harmlessly). Every task in the subtree must resolve
  to its stable UID, else nothing is queued.
- **`sync`** — run MLO QuickSync on demand (every write triggers it
  internally; this reruns it, e.g. to pick up a previously queued delta).

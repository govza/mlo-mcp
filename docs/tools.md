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
  identity. They are recovered first from the `.ml` binary/XML and then, for
  logged tasks, from an unambiguous caption/`ParentUID` cloud path; duplicate
  sibling captions can still leave a task unresolved. `add_task` takes a parent **GUID**
  (`parentUid`, from `get_task`), not a path id.
- **Writes never touch the data file.** Every write queues a sync delta on the
  local cloud endpoint ([mcp-cloud.md](mcp-cloud.md)) and triggers QuickSync;
  MLO's **own** merge logic applies it, and the app keeps running. The
  append-only delta log is the durable record of every change.
- **Verification is advisory.** Write results carry `verified: true` only when
  a fresh post-QuickSync export confirms the change. `verified: false` does
  not mean failure — the delta is durably queued and MLO applies it on the
  next sync session.
- **Batches are atomic.** Batch tools (`ids`/`updates` arrays) send the whole
  batch as ONE delta; one bad entry and nothing is queued.
- **Edit coverage grows with the delta log.** MLO merges a changed task as a
  full 82-column record, and the XML export cannot supply one, so the edit
  tools source the row from the delta log: a task is editable once it was
  added by this server or touched in MLO since the local endpoint took over.
  Anything else fails atomically with a message to make the change in the MLO
  app.

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
- **`cloud_status`** — the local endpoint's cursor, per-origin delta counts,
  and pending entries (mirror of `GET /v1/status`).

## Write tools

All follow queue → QuickSync → verify. See [mcp-cloud.md](mcp-cloud.md) for
the delta/envelope details behind each.

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
  tombstones union-merge harmlessly). Needs binary/XML or unambiguous logged
  GUID recovery for the whole subtree, else nothing is queued.
- **`sync`** — run MLO QuickSync on demand (every write triggers it
  internally; this reruns it, e.g. to pick up a previously queued delta).

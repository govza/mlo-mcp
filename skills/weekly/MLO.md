# MLO binding for the weekly review

How the pure-GTD checklist maps onto MyLifeOrganized via the mlo MCP tools.
This is the only file to change when rebinding the review to a different task
backend.

- Load the `conventions` skill (`mlo:conventions` via plugin) first.
- Queries per checklist area:
  - **Overdue / due soon** → `search_tasks dueBefore:<today>` and
    `search_tasks dueAfter:<today> dueBefore:<today+7d>`.
  - **Active projects** → `search_tasks isProject:true completed:false`, then
    `list_tasks parentId:<id>` per project.
  - **Next actions** → open leaf tasks; MLO's to-do list is built from leaves,
    so a project's actionability = its open leaves.
  - **Waiting-for** → dependency markers (`[waits-on:…]` in listings) or the
    waiting-for context.
  - **Completed last week** → `search_tasks completed:true`, scoped to recent
    dates.
  - **Someday/Maybe** → `list_tasks parentId:<someday-branch>`.
- On large profiles review branch by branch (`parentId` + `maxDepth`) — the
  read tools cap results at 200 per call.
- The end-of-review apply step uses minimal batched writes (batches travel as
  one sync delta). Re-list before writing; path ids gathered during the
  review are stale by then.
- Review log (if enabled in Defaults): append to the Note of a task captioned
  `Weekly Review` via `update_task`.

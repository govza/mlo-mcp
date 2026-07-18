# MLO binding for the mindsweep

How captures land in MyLifeOrganized via the mlo MCP tools. This is the only
file to change when rebinding capture to a different task backend.

- **Inbox** = the top-level `<Inbox>` node (MLO's capture inbox — the caption
  is literally `<Inbox>` in every MLO language; `list_tasks` marks it
  `[inbox]`). `add_task` files unparented tasks there automatically.
- Buffer captured items and write them in `add_task` batches (≤25 per call,
  no parentId — the server routes them to the inbox; check each reported
  placement says "inbox") — batching avoids restarting the MLO app per item,
  but don't hold everything to the very end of a long session; flush between
  categories.
- Captures are bare captions only — no contexts, dates, or importance at this
  stage (that's clarify's job, and it keeps the rapid-entry parser out of the
  way of the user's own words).

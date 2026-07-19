# MLO binding for the mindsweep

How captures land in MyLifeOrganized via the mlo MCP tools. This is the only
file to change when rebinding capture to a different task backend.

- **Inbox** = the top-level `<Inbox>` node (MLO's capture inbox — the caption
  is literally `<Inbox>` in every MLO language; `list_tasks` marks it
  `[inbox]`). Find it once at the start (`list_tasks maxDepth:1`, then
  `get_task` for its GUID) and pass that GUID as `add_task.parentUid` for
  every capture; without a parentUid captures land at the top level.
- `add_task` takes one task per call — write each capture as it lands rather
  than buffering (writes queue sync deltas; the MLO app keeps running).
- Captures are bare captions only — no contexts, dates, or importance at this
  stage (that's clarify's job).

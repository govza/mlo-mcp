# MLO binding for inbox processing

How the pure-GTD process in SKILL.md maps onto MyLifeOrganized via the mlo MCP
tools. This is the only file to change when rebinding the process to a
different task backend.

- Load the `conventions` skill (`mlo:conventions` via plugin) first — its context policy governs every
  context assigned here.
- **Inbox** = the top-level `<Inbox>` node (MLO's capture inbox — the caption
  is literally `<Inbox>` in every MLO language). Find it with
  `list_tasks maxDepth:1` (marked `[inbox]`); list its items with
  `list_tasks parentId:<inbox id>`. New unparented `add_task` items land there
  automatically.
- **Lists and areas** = subtrees of the outline. **Contexts** = MLO Places.
  **Projects** = tasks with subtasks (`isProject`). **Reference** = the task's
  Note field (or a `Reference` subtree). **Trash** = `delete_task`.
- **Applying the plan:** as few write calls as possible — one `add_task` batch,
  one `update_task` batch (moves, renames, contexts), one `delete_task`, one
  `complete_task`. Path ids shift after every write: re-list between write
  calls and never reuse pre-write ids.

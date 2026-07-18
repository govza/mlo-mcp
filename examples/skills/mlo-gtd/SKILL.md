---
name: mlo-gtd
description: The user's GTD conventions for managing tasks in MyLifeOrganized via the mlo MCP tools. Use whenever adding, organizing, or editing MLO tasks (add_task, update_task, etc.) so tasks follow the user's methodology — especially context assignment.
---

# GTD conventions for MyLifeOrganized (mlo MCP)

These are my standing preferences for how tasks in MLO should be managed. Anything I say in the conversation overrides this file.

## Preferences (edit these defaults)

- **Context policy:** every actionable task gets a context. ALWAYS pick from the contexts that already exist in the profile — call `list_contexts` first (or reuse its result from earlier in the conversation). Create a NEW context only when I explicitly ask for one. Contexts are @-prefixed (`@Office`, `@Home`, `@Shopping`).
<!-- Add more conventions here as they solidify, e.g.:
- Capture policy: quick capture as bare top-level tasks; organize later.
- Projects: multi-step outcomes become IsProject with a subtasks outline; sequential ones get CompleteSubTasksInOrder.
- Next actions: star exactly one next action per project.
- Weekly review: list_tasks includeCompleted:false, walk projects top-down, confirm each has a next action.
-->

## How to apply

- Before assigning a context: `list_contexts` → choose the best existing match for where/how the action happens (errands → `@Shopping`, calls/desk work → `@Office`, home chores → `@Home`). Pass it via `add_task.contexts` or `update_task.Places` (Places is a full-replacement list — include existing contexts you mean to keep).
- If no existing context fits, say so and ask whether to create one — do not silently invent contexts.
- When I ask to "GTD-ify" or organize tasks: phrase captions as concrete next actions (verb-first), keep project structure in the outline (nesting, dependencies), and put reference material in the task's Note.
- Tool mechanics (path-id freshness, app restarts around writes, backups) are covered by the tools' own descriptions — follow those; don't re-derive them here.

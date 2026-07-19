---
name: conventions
description: The user's GTD conventions for managing tasks in MyLifeOrganized via the mlo MCP tools. Use whenever adding, organizing, or editing MLO tasks (add_task, update_task, etc.) so tasks follow the user's methodology — especially context assignment.
---

# GTD conventions for MyLifeOrganized (mlo MCP)

These are my standing preferences for how tasks in MLO should be managed. Anything I say in the conversation overrides this file.

## Preferences (edit these defaults)

- **Context policy:** every actionable task gets a context. ALWAYS pick from the contexts that already exist in the profile — call `list_contexts` first (or reuse its result from earlier in the conversation). Create a NEW context only when I explicitly ask for one. Contexts are @-prefixed (`@Office`, `@Home`, `@Shopping`).
<!-- Add more conventions here as they solidify, e.g.:
- Capture policy: quick capture as bare top-level tasks; organize later.
- Projects: multi-step outcomes get their steps nested beneath them (add each with parentUid); set IsProject/CompleteSubTasksInOrder through add_task or update_task.
- Next actions: star exactly one next action per project.
- Weekly review: list_tasks includeCompleted:false, walk projects top-down, confirm each has a next action.
-->

## How to apply

- Context choice: `list_contexts` → the best existing match for where/how the action happens (errands → `@Shopping`, calls/desk work → `@Office`, home chores → `@Home`), then pass it in `Places`. On `update_task`, `Places` is the complete replacement set, so include every context the task should retain.
- Batch related changes into single calls (`add_tasks.tasks`, `update_task.updates`, `complete_task.ids`, …) — batches travel as one sync delta and are atomic. Use `add_tasks.parentKey` for a new nested outline and `dependsOnKeys` for dependencies among its new tasks.
- If no existing context fits, say so and ask whether to create one — do not silently invent contexts.
- When I ask to "GTD-ify" or organize tasks: phrase captions as concrete next actions (verb-first), keep project structure in the outline (nesting via `parentUid` on add or `moveToParentId` on update), and put reference material in the task's Note.
- Tool mechanics (path-id freshness, sync-delta queueing, `verified` semantics, coverage limits) are covered by the tools' own descriptions — follow those; don't re-derive them here.

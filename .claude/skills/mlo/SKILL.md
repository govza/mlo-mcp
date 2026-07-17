---
name: mlo
description: How to manage MyLifeOrganized tasks with the mlo MCP server — id semantics, folders, GUI restart behavior, and which tool to use when. Use whenever working with MLO tasks via the mlo MCP tools.
---

# Managing MLO tasks via the `mlo` MCP server

The server drives the MyLifeOrganized desktop app's CLI. Everything below is about using its tools correctly.

## Ids are positional and perishable

`list_tasks`/`search_tasks` return path ids like `1.2.3` (position in the outline). **Any mutation can shift them.** Always fetch a fresh id right before `get_task`/`update_task`/`complete_task`/`delete_task`/`add_task(parentId)` — never reuse an id from earlier in the conversation. `get_task` also returns a stable `Guid` for cross-referencing, but mutation tools take path ids only.

## Which tool, when

- Browse/overview → `list_tasks` (tree). Filtering → `search_tasks` (query matches caption AND note).
- Create → `add_task`. Prefer ISO `dueDate` ("2026-08-01T15:00") — exact. Natural language ("tomorrow 3pm") routes through MLO's best-effort parser; **always check the reported result text**, captions containing digits can absorb unparsed tokens.
- A "folder" in MLO = task with `HideInToDoThisTask` (visible in outline, hidden from to-do views). Create with `add_task {folder: true}`; convert with `update_task {HideInToDoThisTask: true/false}`.
- Complete → `complete_task` (not update_task) — it also handles project status.
- Field values: Importance/Effort are **0–200** (100 = normal). Delphi booleans: true = `-1` internally; the tools take real booleans.

## Expect the app to restart around writes

If the MLO GUI is open, every exact write (add with fields, update, complete, delete) closes it gracefully (it saves on close), applies the change, and relaunches it (~10s). This is normal — tell the user rather than treating it as an error. If a write fails with "could not close", a modal dialog is blocking MLO: ask the user to dismiss it.

## Safety and recovery

- Every file rewrite leaves `<datafile>.bak-<timestamp>` next to the data file — mention the backup path after destructive operations; restoring a backup = copying it over the data file (with MLO closed).
- Don't run MLO mutations from two sessions concurrently; changes race each other.
- After any mutation, the tool response reports what was actually created/changed and where — trust that over assumptions, and re-list before follow-up mutations.

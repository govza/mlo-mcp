# Examples

## `skills/mlo-gtd` — a personal skill for GTD conventions

An **example, not a final product**: a Claude Code skill that teaches Claude *your* methodology for using the mlo MCP tools (the server itself stays methodology-neutral). This one encodes a single GTD convention — context discipline (reuse the profile's existing contexts via `list_contexts`; never invent new ones unprompted) — plus commented placeholders for conventions you may want to add (capture policy, project structure, next-action starring, weekly review).

### Install

Copy the folder to your **personal** skills directory so it applies in every project:

```powershell
Copy-Item -Recurse examples\skills\mlo-gtd $env:USERPROFILE\.claude\skills\
```

(Or into a repo's `.claude\skills\` to scope it to one project. If both exist, the personal one wins.)

### Customize

Edit the **Preferences** section — it is deliberately short and written as defaults that anything said in conversation overrides. The frontmatter `description` controls when Claude auto-loads the skill; keep it focused on MLO/task-management wording.

Background reading for extending it: [`../docs/mlo-task-model.md`](../docs/mlo-task-model.md) (MLO's task model and GTD concepts) and the tool list in [`../mcp-server/README.md`](../mcp-server/README.md).

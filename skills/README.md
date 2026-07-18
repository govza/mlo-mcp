# Skills

**Customizable examples, not final products.** These Claude Code skills teach
Claude *your* methodology for using the mlo MCP tools — the server itself stays
methodology-neutral (primitives only: list/search/add/update/complete). Each
skill separates the two layers deliberately:

- the **GTD process** is written in pure, tool-agnostic GTD terms — `SKILL.md`
  and the supporting files (`CHECKLIST.md`, `TRIGGERS.md`) mention no tool
  names (only the frontmatter does, for auto-triggering), so you can review or
  rewrite them against the methodology itself;
- the **MLO binding** (which mlo tools implement each operation, batching
  writes, path-id freshness, scoping reads on large profiles) lives in a
  separate `MLO.md` per skill, read only when the skill actually executes —
  rebinding a workflow to a different task backend means replacing that one
  file;
- every **methodology opinion** sits in an editable `Defaults` / `Preferences`
  section meant to be rewritten. Anything said in conversation overrides the
  files.

## The skills

| Skill | What it does |
|---|---|
| `conventions` | Standing conventions applied whenever tasks are added or edited — context discipline, verb-first captions, batching. The other skills load it. |
| `mind` | Guided mindsweep/brain dump: trigger-list prompts, everything captured verbatim into the Inbox, no organizing during capture. |
| `inbox` | GTD clarify & organize: walks each Inbox item through the do / delegate / defer / project / someday / reference / trash decision and files it in batched writes. |
| `weekly` | The get-clear / get-current / get-creative weekly review, driven by an editable `CHECKLIST.md`; reads first, batches all fixes into one apply step at the end. |

Together they cover the GTD loop: capture (`/mind`) → clarify & organize
(`/inbox`) → engage (`conventions`) → reflect (`/weekly`). They also
compose: the weekly review opens by running inbox processing; inbox processing
ends by offering the two-minute-rule items back to you.

The workflow skills auto-trigger from conversation, and can be invoked
explicitly as `/inbox`, `/weekly`, `/mind` (personal copies) or namespaced
`/mlo:inbox`, `/mlo:weekly`, `/mlo:mind` when installed via the plugin.

## Install

Installing the repo as a Claude Code plugin (see the [root README](../README.md))
ships all skills automatically. To customize them — which is the point — copy
them to your **personal** skills directory instead, so your edits survive plugin
updates and apply in every project:

```powershell
Copy-Item -Recurse skills\conventions, skills\inbox, skills\weekly, skills\mind $env:USERPROFILE\.claude\skills\
```

(Or into a repo's `.claude\skills\` to scope them to one project. If both
exist, the personal one wins.)

## Customize

Edit the `Defaults` / `Preferences` sections and the supporting files — they are
deliberately short and written as defaults that conversation overrides. The
frontmatter `description` controls when Claude auto-loads a skill; keep it
focused on MLO/task-management wording. If your GTD differs structurally
(different inbox location, no someday/maybe branch, starred-next-action policy),
change the relevant Default line rather than fighting the process text.

Background reading for extending them: [`../docs/mlo-task-model.md`](../docs/mlo-task-model.md)
(MLO's task model and GTD concepts — outline vs. to-do list, computed priority,
visibility flags) and the tool list in [`../mcp-server/README.md`](../mcp-server/README.md).

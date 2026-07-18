# MLO Task Model & GTD Reference

The conceptual model behind MyLifeOrganized's task properties: how the **To-Do
list** is built from the **Outline**, how tasks are ranked, and what each
property does to a task's visibility and position. The point of this document is
that tasks created through the MCP server land in *sensible* to-do orderings —
to do that you have to know what Importance, Urgency, Contexts, dependencies and
visibility flags actually mean to MLO.

> **Provenance:** distilled from MLO's bundled help (`mlo.chm`, MLO 15.x —
> `sources/extracted/mlo.chm`). Unlike the CLI and format docs in this folder,
> this is *vendor-described* behavior, not behavior we re-verified empirically.
> Where it touches the MCP tools, treat the tools' own descriptions as
> authoritative for exact parameter names and scales.

---

## 1. Outline vs. To-Do list

MLO keeps two views of the same data:

- **Outline** — the full hierarchical tree you edit. Everything lives here.
- **To-Do list** — a filtered, ordered, *flattened* action list derived from
  the outline.

The single most important rule:

> **The To-Do list only shows tasks that have no uncompleted children** (leaf
> "next actions"), ordered by their computed score.

So a parent/branch task is *not* itself an action — it surfaces its leaves.
When the last leaf of a branch is completed, the branch itself becomes a leaf
and then appears (unless it's marked a **Folder** — see §4). This is why a good
plan is: outcomes as branches, concrete verbs as leaves.

---

## 2. Computed-Score Priority (the ranking algorithm)

When a view sorts by **Computed-Score Priority** (the default automatic mode),
every task gets a score from three inputs: **Importance**, **Urgency**, and
**Time** (start/due dates). Views can be configured to rank by importance only,
urgency only, or both.

### Importance and Urgency are *relative to the parent*

You never set an absolute priority. For each task you set how important/urgent it
is **with respect to its immediate parent**, and MLO computes the absolute value
by multiplying down the branch:

```
absolute_importance(task) = importance_to_parent(task) × absolute_importance(parent)
absolute_urgency(task)    = urgency_to_parent(task)    × absolute_urgency(parent)
```

- **Importance inherits down** — a low-importance parent drags down every child.
- **Urgency inherits down** — a high-urgency parent lifts every child.
- The slider is a symmetric log curve around a **Normal** midpoint (neutral,
  ×1.0). A step left is exactly cancelled by an equal step right, so a
  deliberately lowered task can be nullified by an equally raised one.

> **Container tasks:** if a task exists only to *group* others, leave it at
> **Normal** importance. Otherwise it silently lowers everything beneath it.

### Dates feed Urgency

Start/due dates only affect the score when **Urgency is in play** (urgency-only
or combined mode). Intuitively:

- A **start date** contributes more score the further past it you are (the task
  has been "waiting" longer).
- A **due date** contributes more score as it approaches, and keeps climbing
  after it passes if **"increase priority for overdue tasks"** is on.
- Each has an independent **weight factor (0–6)** in the data-file options; higher
  weight = dates dominate the ordering more. You can weight start > due if you
  want "available" work to float up rather than deadline work.

The documented contribution (transcribed faithfully; `now` = current time):

```
StartDateScore = StartWeight × (now − Start)            / 500
DueDateScore   = DueWeight   × (now − Due) × overdueBoost / 500   # boost = 1, or (−0.25 × remaining) when overdue-boost is on
DateScoreContribution = (start set ? StartDateScore : 0) + (due set ? DueDateScore : 0)
```

### Weekly-goal boost

Marking a task a **weekly goal** adds an extra urgency boost (goal slider weight
÷ 150 added to the urgency-to-parent term). See §3, *Goals*.

### Final score

```
importance only : Score = ImportanceScore
urgency only    : Score = UrgencyScore + DateScoreContribution
both (default)  : Score = (ImportanceScore × UrgencyScore) + DateScoreContribution
```

Practical takeaway: **structure and relative importance/urgency do the heavy
lifting; dates nudge.** You rarely need extreme sliders — get the tree right and
mark the one or two genuinely more/less important children.

---

## 3. Task properties that shape order & visibility

| Property | What it does | Notes for planning |
|---|---|---|
| **Context** (a.k.a. Place) | Category/where-you-can-do-it tag used to *filter* the To-Do list. | Multiple per task. Hierarchical — see below. This project's GTD convention: every actionable leaf gets exactly one. |
| **Importance for parent** | Relative importance slider (§2). | Leave grouping/container tasks at Normal. |
| **Urgency** | Relative urgency slider (§2). | Combines with dates. |
| **Start / Due / Lead time** | When the task appears / is due; lead = due − start. | Subtasks inherit parent dates unless overridden. Powerful text input ("tomorrow at 2pm", "in 3 weeks") — see §4. |
| **Recurrence** | Repeats one occurrence at a time; next appears when current is completed. Driven by the **Due** date. | Can regenerate relative to *completion* date, auto-recur when subtasks finish, and reset subtasks each cycle. Setting recurrence disables the plain Start/Due fields (edit them in the Recurrence dialog). |
| **Project** (`IsProject`) | Marks a branch as a project; groups it in the Projects view with a status (Not Started / In Progress / Suspended / Completed). | Status is **manual** — never auto-advances. Completion % is derived from subtasks weighted by **Effort**. |
| **Goal** (week / month / year) | Flags a task into the Goals view; weekly goal also boosts urgency. | Weekly = focus for the week; monthly reviewed weekly; yearly reviewed monthly. |
| **Effort** | Subjective effort (min→max). Feeds project completion % and To-Do effort filtering. | *Different from time.* Reading a book = low effort; writing docs = high effort, same clock time. |
| **Time required** (min/max) | Clock time; feeds the To-Do time filter ("what can I do in 15 min?"). | Independent of Effort. |
| **Starred** | Boolean; collects the task into the **Starred** view. | This project stars the single entry-point next action of a plan. |
| **Flag** | Colored icon for visual grouping/highlighting in the list. | Customizable icons + shortcuts. |
| **Text tag** | A single free-text tag for filtering (one per task, vs. many contexts). | |
| **Review** | "Next review" date + interval; task surfaces in the **Review** view when due, then "Mark Reviewed" rolls it forward. | The GTD weekly-review hook — good on every project branch. |
| **Note** | Free-form note; supports **Markdown** when enabled. | Put reference material here, keep captions as verb-first actions. |

### Contexts are hierarchical

A context can **include** other contexts. If `Home` includes `Phone`, then
filtering the To-Do list by `Home` shows every task tagged `Phone` too. This lets
you tag tasks narrowly (`Phone`) and still see them under broad filters
(`Home`, `Work`). Contexts can also have **open/closed hours** — a task tagged to
a currently-closed context is hidden unless you opt to include closed contexts.

### To-Do visibility flags (§1 mechanics)

| Flag | Effect |
|---|---|
| **Folder** | The task is a pure container: it never appears in the To-Do list itself, even after all its subtasks are done. Use for area/bucket headers. |
| **Hide branch in To-Do** | This task *and its whole subtree* are excluded from standard To-Do views. Use for not-yet-actionable or reference-only branches. |
| **Complete subtasks in order** | Only the next incomplete subtask of the branch is shown; the rest stay hidden until it's done. Turns a branch into a sequential checklist. |

### Dependencies

Independent of the outline hierarchy: a task can be blocked until other tasks
(from *any* branch) are complete.

- Add blockers under the task's **Dependencies**; it stays out of the **Active
  Actions** view until they clear (ALL vs. ANY is configurable).
- **Delayed dependency:** after the blockers clear, keep the task inactive for a
  further delay (e.g. "Hang wallpaper" activates 1 day after "Paint the door").
  With ALL, the delay counts from the last blocker completed; with ANY, from the
  first.
- The dependency is ignored if the view's Action Filter is set to *Available*.

Use dependencies for cross-branch ordering; use **Complete subtasks in order**
for within-branch sequencing.

---

## 4. Input parsing (quick capture grammar)

MLO's Rapid Task Entry and in-outline editor can **parse** a single line into a
task plus properties. The MCP server exposes this via its parse-text input; the
grammar below is what the parser understands. Pattern:

```
<What?> [<When?>] [remind[er] <When?>] [@ <context>; <context>...] [switches]
```

Dates/times are natural language: `tomorrow 3pm`, `in 30 min`, `next Friday`,
`in 3 weeks Fri`, `Jan26`, `26-3-2008`, `today in 1h 25min`.

**Reserved words** include the weekday/month names, numbers, and:
`context @ remind reminder next in after before day(s)/d month(s)/m year(s)/y
week(s)/w am pm p h hr(s) hour(s) minute(s)/min today now`. If a caption trips
the parser, wrap the caption in `"quotes"` to protect it.

**Contexts:** `@name` (or the word `context`) adds contexts, `;`-separated. A
leading `@` needs no keyword: `Call Jim tomorrow @office; @calls`.

**Switches** (Rapid Task Entry / `Alt+Enter` in the outline):

| Switch | Effect | | Switch | Effect |
|---|---|---|---|---|
| `-i1`..`-i5` | Importance min→max | | `-p` | Mark **IsProject** |
| `-u1`..`-u5` | Urgency min→max | | `-f` | Mark **Folder** |
| `-e1`..`-e5` | Effort min→max | | `-g` | Mark **Goal** |
| `-t<time>` | Time required (`-t10`, `-t2h15min`) | | `-h` | Hide in To-Do |
| `-tmax<time>` | Max time required | | `-o` | Complete subtasks in order |
| `-l<time>` | Lead time (`-l2d`) | | `-star` / `-*` | Starred |
| `-s` / `-start` | Put the date in **Start** | | `-fl<Flag>` | Set flag (`-flGreen`) |
| `-d` / `-due` | Put the date in **Due** | | `-c<Color>` | Font color (`-cr` = red) |
| `+@ <ctx>` | *Add* contexts (don't replace) | | `-toprj<Prj>` / `-tofld<Fld>` / `-to<Task>` | Move under project / folder / task |

Example — `Call Katrin -t10 tomorrow 3p remind me 15 min in advance @calls -i1 -e4 -cr`
→ caption "Call Katrin", due tomorrow 3:00pm, reminder 2:45pm, context `@calls`,
time 10min, importance max, effort more, red.

---

## 5. Selected keyboard shortcuts

Handy when driving the GUI to check what the MCP server wrote.

| Shortcut | Action |
|---|---|
| `Alt+F1` / `Alt+F2` | Toggle Task-views pane / Properties pane |
| `Alt+2`..`Alt+9` | Open properties section: General, Timing, Effort, Project, Dependencies, Format, Review, Statistics |
| `Ins` / `Ctrl+N` | New task · `Alt+Ins` new subtask · `Shift+Ctrl+Ins` new folder |
| `Ctrl+D` | Duplicate task(s) · `Ctrl+Del` delete |
| `Alt+Shift+←↑↓→` | Rearrange (indent/outdent/move) tasks in the outline |
| `Alt+C` / `Alt+L` | Edit / pick Context |
| `Alt+J` | Toggle "This is a Project" · `Alt+W` weekly goal · `Alt+Y` hide-in-todo · `Alt+P` complete-subtasks-in-order |
| `Alt+D` | Set due date · `Ctrl+=` / `Ctrl+-` ±1 day · `Ctrl+Alt+=` / `-` ±1 week |
| `F6` / `F7` | Collapse / expand entire list · `Ctrl+`` collapse-expand current |
| `Ctrl+Shift+M` | Rapid Task Entry (global) |

---

## 5b. The Inbox (empirically verified)

MLO's capture inbox is an **ordinary top-level task captioned literally
`<Inbox>`** — the built-in Inbox view (ToDoViewType 3) shows its children, and
GUI rapid entry files new tasks under it, creating the node on first use.

The caption **is** the identity, in every UI language:

- `<Inbox>` is hardcoded as a UTF-16 string in `mlo.exe`; the `.lng` language
  files translate only the Inbox *view* label (Russian "Входящее"), not the
  node caption — a Russian profile still stores `<Inbox>`.
- The profile contains no other pointer to the node: its GUID appears exactly
  once (its own task record) in both the task DB and the app-state streams.

The CLI (`-AddSubtask` without `-task`) bypasses the inbox and targets the tree
root — which is why the server resolves the inbox itself: `add_task` without a
`parentId` files under the `<Inbox>` node (or a plain `Inbox`, or the
`MLO_INBOX_CAPTION` override), and `parentId: "root"` forces top level.

## 6. How this maps to the MCP tools

The concepts above are what the `add_task` / `update_task` fields ultimately set.
Rough correspondence (see each tool's own description for exact names/scales):

- **Contexts** → `add_task.contexts` / `update_task.Places` (full-list replace).
  Follow the `conventions` skill: one existing context per actionable leaf.
- **Starred / Folder / dates / note** → the like-named inputs.
- **Project** → set `IsProject` via `update_task`.
- **Sequencing** → *within* a branch use complete-subtasks-in-order; *across*
  branches use dependencies (the server supports reading/writing them).
- **Quick capture** → the parse-text input feeds the §4 grammar.

**Rule of thumb for a good plan:** areas/buckets as **Folders**, outcomes as
**project** branches, concrete verb-first **leaves** as the actions, one
**context** per leaf, relative **importance** only where a child genuinely
differs, dates only where a real deadline exists, and a **review** interval on
each project branch.

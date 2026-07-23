# Issue tracker: GitHub + local markdown (hybrid)

This repo uses two tiers:

- **GitHub Issues** (`govza/mlo-mcp`, via the `gh` CLI) — the official tracker. Settled, actionable issues live here.
- **Local markdown** under `.scratch/` (gitignored) — work-in-progress: draft specs, exploratory ticket breakdowns, and wayfinding efforts that aren't ready to be official.

Rule of thumb: work starts in `.scratch/` while it's still being shaped; once an issue is fully specified and worth tracking officially, promote it to a GitHub issue (and note the GitHub number back in the local file, or delete the local file).

## GitHub conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Local markdown conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file, using the role strings from `triage-labels.md`
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

`.scratch/` is gitignored — never commit its contents.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

- Work-in-progress output (draft specs, ticket breakdowns from `/to-tickets`, notes): create files under `.scratch/<feature-slug>/`.
- An official, fully-shaped issue (or when the user says "file it" / "make it official"): create a GitHub issue with `gh issue create`.
- When unsure, default to `.scratch/` and mention that it can be promoted.

## When a skill says "fetch the relevant ticket"

- A bare `#<number>` refers to a GitHub issue: `gh issue view <number> --comments`.
- A file path (or feature slug) refers to a local ticket: read the file under `.scratch/`.

## Wayfinding operations

Used by `/wayfinder`. Wayfinding efforts are work-in-progress, so they live in local markdown. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

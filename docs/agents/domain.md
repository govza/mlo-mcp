# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo: one `CONTEXT.md` at the repo root, backed by an existing body of reference docs under `docs/`.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary and entry point. It defines the ubiquitous language and points into the deep reference docs.
- **The reference docs it links** — `docs/README.md` indexes them: `docs/tools.md` (tool semantics), `docs/server-architecture.md` (server internals), `docs/mcp-cloud.md` (the sync endpoint), and `docs/mlo/` (reverse-engineered MLO formats and protocol). Read the ones relevant to the area you're working in; they are the authoritative domain documentation, not just background.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If `docs/adr/` (or a linked doc) doesn't exist, **proceed silently**. Don't flag the absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates ADRs lazily when decisions actually get resolved.

## Decisions

Established decisions predating this setup are recorded in prose inside the reference docs (e.g. "writes never touch the data file" in `docs/tools.md`; "switching sync endpoints is not a reconnect" in `docs/mlo/cloud-sync.md`). Leave them there — don't retro-extract ADRs. **New** decisions go to `docs/adr/` as numbered records.

## File structure

```
/
├── CONTEXT.md                 ← glossary / entry point
├── docs/
│   ├── README.md              ← index of the reference docs
│   ├── adr/                   ← new decisions (created lazily)
│   ├── agents/                ← these convention files
│   ├── tools.md, server-architecture.md, mcp-cloud.md
│   └── mlo/                   ← reverse-engineered MLO formats & protocol
└── mcp-server/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

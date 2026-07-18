# mlo-mcp server architecture

TypeScript MCP server (`mcp-server/`) over stdio. Node 22, pnpm, ESM, strict TS; `@modelcontextprotocol/sdk` + `fast-xml-parser` + `zod`. Model types keep MLO's original Delphi PascalCase field names.

## Module map

```
src/
  index.ts          McpServer wiring, registerTool calls, stdio transport
  config.ts         env config (MLO_DATA_FILE required; MLO_EXE_PATH, MLO_EXPORT_DIR,
                    MLO_CACHE_STALE_MS, MLO_AUTO_RESTART_GUI)
  mlo-cli.ts        mlo.exe invocation: Delphi quoting, timeouts, exit-code mapping,
                    both locks, GUI close/relaunch, isMloRunning
  xml.ts            parse/build (fast-xml-parser), RawTaskNode, canonical field order
  task-tree.ts      RawTaskNode → TaskNode model, path ids, find/flatten/search/render
  guids.ts          Caption→GUID recovery from the .ml binary (see ml-binary-format.md)
  store.ts          cached snapshot: export → parse → tree → GUID annotation
  write-pipeline.ts the file-replacement write (below)
  tools/*.ts        one file per tool + shared helpers
```

## Concurrency: two locks

1. **In-process**: a promise-chain mutex serializes every mlo.exe invocation within one server.
2. **Cross-process**: a lock *directory* next to the data file (`<file>.ml.mcp-lock`, atomic `mkdir`, stale-broken after 3 min) serializes invocations across multiple server processes — one per Claude session — and the GUI restarts. Held across the *entire* write pipeline, not just individual invocations. Reentrant within a process via a held-flag.

Why: MLO invocations racing each other (or a booting GUI) trigger a modal "file is locked by another process" dialog and hang forever.

## Reads

`store.ts` keeps a snapshot (XML export → parsed doc → TaskNode tree → GUIDs annotated from the binary) cached for `MLO_CACHE_STALE_MS` (default 30 s). Every mutation invalidates it. Ids are path-based (`1.2.3` = position, root excluded) and shift when the tree changes — tools tell agents to re-list before mutating.

## The write pipeline (`replaceDataFile`)

All exact writes go through one function:

```
lock (both) → [GUI running? close it gracefully] → fresh export → mutate parsed doc
→ build XML → mlo.exe -saveML to temp → backup original (<file>.bak-<ts>)
→ copy over data file → verify via re-export (predicate) → [restore backup on failure]
→ [relaunch GUI, wait until it has loaded] → unlock
```

- **GUI auto-restart**: a running MLO holds the tree in memory and would clobber the replaced file on its next autosave, so it is closed first — `taskkill` *without* `/F` posts WM_CLOSE, the same as clicking X, and MLO saves on close. After the swap the GUI is relaunched detached — by default **minimized without focus** (`cmd /c start /min`; Node can't set `STARTUPINFO.wShowWindow` itself), which combined with MLO's "Minimize to system tray" option makes the restart invisible. The pipeline waits until MLO is ready before releasing the lock — window-title poll *or* a data-file lock probe (a tray-hidden window has no title) — because returning earlier lets the next invocation race the boot. `MLO_AUTO_RESTART_GUI=0` restores refuse-while-open behavior; `MLO_RELAUNCH_STYLE` = `minimized` (default) / `normal` / `none`.
- **Verification is caption-based** where GUIDs are involved: `-saveML` regenerates all GUIDs on every import, so predicates must not compare GUID values across a write.

## add_task's three paths

| Condition | Path | Guarantees |
|---|---|---|
| No parser needs; fields/parent/subtasks, or GUI open | **XML insert** via write pipeline | exact caption, fields, placement; subtree (`subtasks` outline) atomic |
| Bare caption, no GUI running | `-AddSubtask` IPC | exact caption, top level, fast (no restart) |
| NL date / urgency / parseText | `-Parse` | best-effort (see mlo-cli.md); result verified from a re-export and the task **relocated** if the GUI's selected row hijacked placement |

## Error handling & safety conventions

- Tools return `{isError, content}` with actionable messages, never throw to the transport; stderr-only logging (stdout is JSON-RPC).
- Every rewrite leaves a timestamped backup next to the data file; verification failure auto-restores it.
- Annotations: `readOnlyHint` on list/search/get, `destructiveHint` on complete/update/delete, `idempotentHint` on sync. All tools return `structuredContent` matching an `outputSchema`.

## Tests (vitest, 3 projects-in-2)

- **unit** — parser/builder round-trip, tree ids, filters, outline parsing; fixture is a real export.
- **mlo** (serial, slow) — real mlo.exe against a temp copy of the test profile: export, parse-path adds, exit codes, GUID recovery, E1 round-trip, write pipeline incl. backup-restore.
- **e2e** (inside mlo project) — real MCP client over stdio: tool listing/annotations, add/search/complete/update/delete cycles, folders, subtrees, re-parenting, dependencies.

GUI must be closed for the mlo project (guarded with a clear failure message).

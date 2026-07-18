import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { isMloBusy } from "./mlo-cli.js";
import { MloStore } from "./store.js";
import { log } from "./log.js";
import { allTools } from "./tools/registry.js";
import { registerTool } from "./tools/shared.js";

/** Connection-time usage guide shown to the LLM (MCP `instructions`). */
const INSTRUCTIONS = `
## MyLifeOrganized (MLO) task management

MLO is an OUTLINER: tasks live in one deep tree, and deep nesting is idiomatic. Prefer placing
tasks under parents (parentId, subtasks outlines) over flat top-level lists.

### Ids
Task ids are PATH-BASED ("1.2.3" = position in the tree) and shift whenever the tree changes.
Treat them as valid only for immediate follow-up calls; after any write (or if MLO was used
interactively), re-run list_tasks/search_tasks before using ids again. Never store ids.

### Writes are expensive — batch them
Every write rewrites the data file and, if the MLO app is open, closes and relaunches it.
Always group related changes into ONE call:
- add_task: \`tasks\` array (up to 25, each with own parent/fields) and/or a \`subtasks\` outline per task
- update_task: \`updates\` array (up to 25 field edits/moves in one write)
- complete_task / uncomplete_task / delete_task: \`ids\` arrays
Each write keeps a timestamped backup next to the data file; batches are atomic (one bad id → no change).

### Field conventions
- Contexts are MLO "Places" (@Office, @Home). Run list_contexts first and reuse existing ones.
  update_task's Places is a FULL-replacement list.
- Importance/Effort are stored 0–200 (100 = normal); add_task takes a 1–5 scale instead.
- Dates are local ISO without timezone ("2026-08-01T15:00:00").
- RECURRING tasks: their pattern lives in Recurrence fields the tools do not edit. Overwriting
  DueDateTime on a recurring task can desync the series — get_task first, and prefer letting MLO
  handle recurrence.
- add_task's natural-language dates/urgency/parseText use MLO's best-effort rapid-entry parser;
  everything else is written exactly. Batch mode is exact-only.
- add_task without a parentId files the task into the profile's capture inbox — the top-level
  "<Inbox>" node (same caption in every MLO language; list_tasks marks it [inbox]). Pass
  parentId "root" for a deliberate top-level task. No inbox node → top level, and the result
  says so.

### Completion
complete_task marks done (projects get ProjectStatus too); uncomplete_task reopens.
sync runs the profile's cloud/Wi-Fi QuickSync.
`.trim();

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MloStore(config);
  const ctx = { config, store };

  const server = new McpServer({ name: "mlo-mcp", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  for (const tool of allTools) registerTool(server, tool, ctx);

  await server.connect(new StdioServerTransport());
  log(`ready — data file: ${config.dataFile}`);
  watchOwnBuild();
}

/**
 * Long-lived sessions kept running stale server builds after every rebuild
 * (stdio servers live as long as the client connection). Watch our own entry
 * file; when a rebuild changes it, exit cleanly while idle so the client
 * respawns the current code on the next tool call.
 */
function watchOwnBuild(): void {
  const entry = fileURLToPath(import.meta.url);
  let startMtime: number | undefined;
  const timer = setInterval(async () => {
    try {
      const mtime = (await fs.stat(entry)).mtimeMs;
      startMtime ??= mtime;
      if (mtime !== startMtime && !isMloBusy()) {
        log("server build changed on disk — exiting so the client restarts the new version");
        process.exit(0);
      }
    } catch {
      /* transient stat failure (mid-rebuild) — retry next tick */
    }
  }, 15_000);
  timer.unref();
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

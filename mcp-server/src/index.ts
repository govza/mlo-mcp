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
import { CloudState } from "./cloud/state.js";
import { startCloudServer, type CloudServerHandle } from "./cloud/server.js";

/** Connection-time usage guide shown to the LLM (MCP `instructions`). */
const INSTRUCTIONS = `
## MyLifeOrganized (MLO) task management

MLO is an OUTLINER: tasks live in one deep tree, and deep nesting is idiomatic. Prefer placing
tasks under parents over flat top-level lists.

### Ids
Task ids are PATH-BASED ("1.2.3" = position in the tree) and shift whenever the tree changes.
Treat them as valid only for immediate follow-up calls; after any write (or if MLO was used
interactively), re-run list_tasks/search_tasks before using ids again. Never store path ids.
add_task takes a parent GUID (\`parentUid\`, from get_task) instead of a path id.

### How writes work
Writes never touch the data file. Each write queues a sync delta on the local cloud endpoint
and triggers MLO's QuickSync; MLO's own merge logic applies it, and the app keeps running.
The result's \`verified\` flag says whether a fresh export confirmed the change — \`false\`
means "queued, not applied yet", not failure; MLO applies it on its next sync session.
Batch tools (\`ids\`/\`updates\` arrays) send the whole batch as ONE delta and are atomic:
one bad id and nothing is queued.

### Coverage limits (fail fast, nothing queued)
- update_task / complete_task / uncomplete_task need the task's full record in the delta
  log — available once a task was added by this server or changed in MLO since the local
  endpoint took over. Otherwise make the change in the MLO app.
- update_task cannot edit booleans (IsProject, Starred, Hide*), Flag, Places, or
  dependencies yet; date edits on recurring tasks are refused (the series would desync).
- complete_task refuses recurring tasks — completing in MLO generates the next occurrence.
- delete_task removes each task AND its whole subtree; it needs recoverable GUIDs for the
  full subtree.

### Field conventions
- Dates are local ISO without timezone ("2026-08-01T15:00:00").
- Importance/Effort are 0–200 (100 = normal).
- Contexts are MLO "Places" (@Office); currently read-only (list_contexts, search filters).

### Completion
complete_task marks done (projects get ProjectStatus too); uncomplete_task reopens.
sync runs the profile's QuickSync; cloud_status shows the local endpoint's cursor and log.
`.trim();

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MloStore(config);
  const cloudState = new CloudState(config.cloudStateDir);
  const ctx = { config, store, cloudState };
  const cloudServer = await startCloudServer({ host: config.cloudHost, port: config.cloudPort, stateDir: config.cloudStateDir, state: cloudState });

  const server = new McpServer({ name: "mlo-mcp", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  for (const tool of allTools) registerTool(server, tool, ctx);

  await server.connect(new StdioServerTransport());
  log(`ready — data file: ${config.dataFile}`);
  watchOwnBuild(cloudServer);
  const shutdown = async () => {
    await cloudServer.stop();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

/**
 * Long-lived sessions kept running stale server builds after every rebuild
 * (stdio servers live as long as the client connection). Watch our own entry
 * file; when a rebuild changes it, exit cleanly while idle so the client
 * respawns the current code on the next tool call.
 */
function watchOwnBuild(cloudServer: CloudServerHandle): void {
  const entry = fileURLToPath(import.meta.url);
  let startMtime: number | undefined;
  const timer = setInterval(async () => {
    try {
      const mtime = (await fs.stat(entry)).mtimeMs;
      startMtime ??= mtime;
      if (mtime !== startMtime && !isMloBusy()) {
        log("server build changed on disk — exiting so the client restarts the new version");
        await cloudServer.stop();
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

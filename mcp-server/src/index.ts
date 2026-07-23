import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, detectRunningProfileAsync } from "./config.js";
import type { MloConfig } from "./types.js";
import { isMloBusy } from "./mlo-cli.js";
import { MloStore } from "./store.js";
import { log } from "./log.js";
import { allTools } from "./tools/registry.js";
import { registerTool } from "./tools/shared.js";
import { CloudGateway } from "./cloud/gateway.js";
import { startOrAttachCloudServer, type CloudServerHandle } from "./cloud/server.js";

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
add_tasks creates up to 50 tasks atomically; local \`key\` values connect its
\`parentKey\` and \`dependsOnKeys\` outline/dependency references.

### How writes work
Writes never touch the data file. Each write travels as a cloud sync delta with full task
records: in the default upstream mode it is pushed to the real vendor Cloud in the endpoint's
own sync session (vendor and mobile stay in sync) and reaches the app on its next QuickSync;
in local mode it is queued on the local replacement endpoint. Either way MLO's own merge
logic applies it and the app keeps running. The result's \`verified\` flag says whether a
fresh export confirmed the change — \`false\` means "accepted, not applied yet", not failure.
Batch tools (\`ids\`/\`updates\` arrays) send the whole batch as ONE delta and are atomic:
one bad id and nothing is queued.

### Bootstrap (one-time per profile)
Writes need a bootstrapped cloud partition. If a tool fails with "run cloud_bootstrap":
for upstream mode run one ordinary MLO sync through the proxy, then call cloud_bootstrap —
it pulls the vendor's complete history automatically and enables reads and writes for every
existing task. cloud_status shows binding, lifecycle, and mirror coverage.

### Field support and refusals (fail fast, nothing queued)
- add_task/update_task support Folder, Project, Starred, visibility/sequential
  booleans, existing Flag assignment, and existing contexts (Places).
- update_task replaces dependencies through \`dependsOnIds\` (path ids resolved
  atomically to GUIDs); date edits on recurring tasks are refused (the series would desync).
- complete_task refuses recurring tasks — completing in MLO generates the next occurrence.
- delete_task removes each task AND its whole subtree.

### Field conventions
- Dates are local ISO without timezone ("2026-08-01T15:00:00").
- Importance/Effort are 0–200 (100 = normal).
- Contexts are MLO "Places" (@Office); pass existing captions in \`Places\` after
  consulting list_contexts. On update, \`Places\` is the complete replacement set.

### Completion
complete_task marks done (projects get ProjectStatus too); uncomplete_task reopens.
sync runs the profile's QuickSync; cloud_status shows the local endpoint's cursor and log.
`.trim();

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MloStore(config);
  const cloud = new CloudGateway({ stateRoot: config.cloudStateRoot });
  const ctx = { config, store, cloudState: cloud.defaultState(), cloud };
  // undefined = another session already serves the endpoint; this one shares
  // the delta log via CloudState's cross-process locking and needs no listener.
  const cloudServer = await startOrAttachCloudServer({ host: config.cloudHost, port: config.cloudPort, gateway: cloud });

  const server = new McpServer({ name: "mlo-mcp", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  for (const tool of allTools) registerTool(server, tool, ctx);

  await server.connect(new StdioServerTransport());
  log(`ready — data file: ${config.dataFile}`);
  watchOwnBuild(cloudServer);
  watchProfileSwitch(config, cloudServer);
  const shutdown = async () => {
    await cloudServer?.stop();
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
function watchOwnBuild(cloudServer: CloudServerHandle | undefined): void {
  const entry = fileURLToPath(import.meta.url);
  let startMtime: number | undefined;
  const timer = setInterval(async () => {
    try {
      const mtime = (await fs.stat(entry)).mtimeMs;
      startMtime ??= mtime;
      if (mtime !== startMtime && !isMloBusy()) {
        log("server build changed on disk — exiting so the client restarts the new version");
        await cloudServer?.stop();
        process.exit(0);
      }
    } catch {
      /* transient stat failure (mid-rebuild) — retry next tick */
    }
  }, 15_000);
  timer.unref();
}

/**
 * An auto-detected profile is a snapshot: if the user opens a different
 * profile in MLO mid-session, this long-lived process would keep serving the
 * old one. Same remedy as watchOwnBuild — poll the registry value and exit
 * cleanly while idle so the client respawns against the new profile on the
 * next tool call. Never fires when a --data-file test pin is in effect.
 */
function watchProfileSwitch(config: MloConfig, cloudServer: CloudServerHandle | undefined): void {
  if (!config.dataFileAutoDetected) return;
  const timer = setInterval(async () => {
    const current = await detectRunningProfileAsync();
    if (current && current !== config.dataFile && !isMloBusy()) {
      log(`MLO switched profiles (${config.dataFile} → ${current}) — exiting so the client restarts against it`);
      await cloudServer?.stop();
      process.exit(0);
    }
  }, 60_000);
  timer.unref();
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools } from "./tools/registry.js";
import { NOTE_DESCRIPTION, registerTool, type ToolContext } from "./tools/shared.js";
import { SERVER_INFO } from "./version.js";

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

### Binding mismatch (writes refused, nothing queued)
If a write fails with "binding mismatch", MLO is syncing a different dataFileUID than the
one this profile is bound to, so the queue it would land in is one the app never reads.
Retrying cannot help and the failure is not partial. Report the two UIDs the message names
and stop; repair is the user's call (cloud_bootstrap { rebind: true } — cloud_status reports
\`bindingMismatch\` alongside the two UIDs).

### The sync endpoint
MLO's sync proxy points at a loopback endpoint that runs as its own long-lived process, shared
by every client and started automatically. Writes and cloud_bootstrap borrow the vendor
credentials it holds, so they fail with a clear reason when it is down; reads never need it.
cloud_status reports \`endpoint\` (url, reachable, version). If a write is refused because the
cloud file "moved while this write was being authored", something else changed it concurrently:
retry once and it is re-authored from the current rows.

### Field support and refusals (fail fast, nothing queued)
- add_task/update_task support Folder, Project, Starred, visibility/sequential
  booleans, existing Flag assignment, and existing contexts (Places).
- update_task replaces dependencies through \`dependsOnIds\` (path ids resolved
  atomically to GUIDs); date edits on recurring tasks are refused (the series would desync).
- complete_task refuses recurring tasks — completing in MLO generates the next occurrence.
- delete_task removes each task AND its whole subtree.

### Field conventions
- \`note\`: ${NOTE_DESCRIPTION}. Nothing infers it — pass it or leave it empty.
- Dates are local ISO without timezone ("2026-08-01T15:00:00").
- Importance/Effort are 0–200 (100 = normal).
- Contexts are MLO "Places" (@Office); pass existing captions in \`Places\` after
  consulting list_contexts. On update, \`Places\` is the complete replacement set.

### Completion
complete_task marks done (projects get ProjectStatus too); uncomplete_task reopens.
sync runs the profile's QuickSync; cloud_status shows the local endpoint's cursor and log.
`.trim();

/**
 * The whole protocol surface a client sees: the server's identity, the
 * connection-time guide, and the tool registry. Kept apart from index.ts's
 * process lifecycle because index.ts starts a cloud endpoint and runs main()
 * on import — a test can construct this, connect a real client to it in
 * memory, and assert what actually crosses the wire.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const tool of allTools) registerTool(server, tool, ctx);
  return server;
}

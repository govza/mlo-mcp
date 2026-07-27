import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools } from "./tools/registry.js";
import { NOTE_DESCRIPTION, registerTool, type ToolContext } from "./tools/shared.js";
import { SERVER_INFO } from "./version.js";

/** Connection-time usage guide shown to the LLM (MCP `instructions`). */
const INSTRUCTIONS = `
## MyLifeOrganized (MLO) task management

MLO is an OUTLINER: tasks live in one deep tree, and deep nesting is idiomatic.

### Reads only, for now
This build serves reads while the write path is re-architected (local-landing writes,
ADR-0005). There are no write tools; suggest making changes in the MLO app directly.

### Ids
Task ids are PATH-BASED ("1.2.3" = position in the tree) and shift whenever the tree changes.
Treat them as valid only for immediate follow-up calls; if MLO was used interactively,
re-run list_tasks/search_tasks before using ids again. Never store path ids.
get_task also reports the task's stable GUID when it is recoverable.

### Field conventions
- \`note\`: ${NOTE_DESCRIPTION}.
- Dates are local ISO without timezone ("2026-08-01T15:00:00").
- Importance/Effort are 0–200 (100 = normal).
- Contexts are MLO "Places" (@Office); list_contexts enumerates them.

### The sync endpoint
MLO's sync proxy points at a loopback endpoint that runs as its own long-lived process, shared
by every client and started automatically. Reads never need it. cloud_status reports
\`endpoint\` (url, reachable, version) plus the profile's partition binding.
sync runs the profile's QuickSync.
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allTools } from "./tools/registry.js";
import { NOTE_DESCRIPTION, registerTool, type ToolContext } from "./tools/contract.js";
import { SERVER_INFO } from "./version.js";

/** Connection-time usage guide shown to the LLM (MCP `instructions`). */
const INSTRUCTIONS = `
## MyLifeOrganized (MLO) task management

MLO is an OUTLINER: tasks live in one deep tree, and deep nesting is idiomatic.

### Writes land on MLO's own next sync
A write tool returns as soon as the change is DURABLY QUEUED - not when MLO has applied it.
The response carries a \`writeId\` and an \`expiresAt\`; nothing waits, and there is no
"verified" flag to read. MLO picks the write up on its own sync (about 90 seconds, or
immediately if you run sync), and reads show the change straight away, flagged
\`pending: true\` with the writeId that made it. One residual case: when a task's
identity cannot be resolved against the captured rows, its queued change shows as a
separate pending row instead of updating the task in place.

Do not poll: report the change as made. If you want the outcome anyway, write_status(writeId)
gives the five states - accepted, delivered, verified, expired (MLO never synced; nothing was
applied), superseded (MLO kept its own conflicting version). cloud_status carries the queue
depth and the recent writes that never landed.

### Ids
Task ids are PATH-BASED ("1.2.3" = position in the tree) and shift whenever the tree changes.
Treat them as valid only for immediate follow-up calls; if MLO was used interactively,
re-run list_tasks/search_tasks before using ids again. Never store path ids.
Write targets also accept the task's stable GUID in braces ("{XXXXXXXX-...}") - reads and
write accepts return it, and it survives tree shifts; prefer it whenever you hold one.
After your own queued structural write (add/move/delete), never compute a destination path
id yourself: the queued change has not applied yet, so a computed id is accepted against
whatever task sits at that path today. Re-run search/list and target the row carrying the
expected GUID.
Check that the uid and caption echoed in every write accept name the task you meant
before treating the write as correct.

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

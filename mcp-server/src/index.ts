import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { MloStore } from "./store.js";
import { log } from "./log.js";
import { registerListTasks } from "./tools/list-tasks.js";
import { registerSearchTasks } from "./tools/search-tasks.js";
import { registerGetTask } from "./tools/get-task.js";
import { registerAddTask } from "./tools/add-task.js";
import { registerSync } from "./tools/sync.js";
import { registerListContexts } from "./tools/list-contexts.js";
import { registerCompleteTask } from "./tools/complete-task.js";
import { registerUpdateTask } from "./tools/update-task.js";
import { registerDeleteTask } from "./tools/delete-task.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new MloStore(config);
  const ctx = { config, store };

  const server = new McpServer({ name: "mlo-mcp", version: "0.1.0" });
  registerListTasks(server, ctx);
  registerSearchTasks(server, ctx);
  registerGetTask(server, ctx);
  registerAddTask(server, ctx);
  registerSync(server, ctx);
  registerListContexts(server, ctx);
  registerCompleteTask(server, ctx);
  registerUpdateTask(server, ctx);
  registerDeleteTask(server, ctx);

  await server.connect(new StdioServerTransport());
  log(`ready — data file: ${config.dataFile}`);
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

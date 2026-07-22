/**
 * Invoke any tool directly, no MCP client needed. Requires MLO_DATA_FILE in
 * the environment (`pnpm tools` browses the catalog without one).
 *
 *   pnpm tool list_tasks '{"format":"flat"}'
 *   pnpm tool add_task '{"caption":"Test task"}'
 */
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { MloStore } from "../src/store.js";
import { allTools } from "../src/tools/registry.js";
import { CloudGateway } from "../src/cloud/gateway.js";
import { renderList } from "./tool-catalog.js";

const [name, json] = process.argv.slice(2);

if (!name || name === "--list") {
  console.log(renderList());
  process.exit(0);
}

const tool = allTools.find((t) => t.name === name);
if (!tool) {
  console.error(`unknown tool "${name}" — run \`pnpm tools\` to see them all`);
  process.exit(1);
}

const config = loadConfig();
const cloud = new CloudGateway({
  stateRoot: config.cloudStateRoot,
  legacyStateDir: config.cloudLegacyStateDir,
  defaultMode: config.cloudMode,
});
const ctx = { config, store: new MloStore(config), cloudState: cloud.defaultState(), cloud };
const args = z.object(tool.inputSchema).parse(JSON.parse(json ?? "{}"));

const result = await tool.execute(args, ctx);
if (result.isError) process.exitCode = 1;
for (const block of result.content ?? []) {
  if (block.type === "text") console.log(block.text);
}
if (result.structuredContent) {
  console.log("\n--- structuredContent ---");
  console.log(JSON.stringify(result.structuredContent, null, 2));
}

/**
 * Invoke any tool directly, no MCP client needed. Requires MLO_DATA_FILE in
 * the environment.
 *
 *   pnpm tool --list
 *   pnpm tool list_tasks '{"format":"flat"}'
 *   pnpm tool add_task '{"caption":"Test task"}'
 */
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { MloStore } from "../src/store.js";
import { allTools } from "../src/tools/registry.js";
import { CloudState } from "../src/cloud/state.js";

const [name, json] = process.argv.slice(2);

if (!name || name === "--list") {
  for (const t of allTools) {
    const params = Object.keys(t.inputSchema).join(", ") || "(no params)";
    console.log(`${t.name.padEnd(18)} ${params}`);
  }
  process.exit(0);
}

const tool = allTools.find((t) => t.name === name);
if (!tool) {
  console.error(`unknown tool "${name}" — run with --list`);
  process.exit(1);
}

const config = loadConfig();
const ctx = { config, store: new MloStore(config), cloudState: new CloudState(config.cloudStateDir) };
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

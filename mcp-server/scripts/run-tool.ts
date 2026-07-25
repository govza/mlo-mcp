/**
 * Invoke any tool directly, no MCP client needed. Resolves the profile like
 * the server does — MLO's current profile, auto-detected
 * (`pnpm tools` browses the catalog without any profile).
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
const cloud = new CloudGateway({ stateRoot: config.cloudStateRoot });
// This script starts no listener, so it holds no vendor contacts of its own —
// the same position an attached MCP client is in, and the refusals that flow
// from that are the accurate ones here.
const ctx = { config, store: new MloStore(config), cloudState: cloud.defaultState(), cloud, endpointRole: "attached" as const };
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

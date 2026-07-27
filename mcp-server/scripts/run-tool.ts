/**
 * Invoke any tool directly, no MCP client needed. Resolves the profile like
 * the server does — MLO's current profile, auto-detected
 * (`pnpm tools` browses the catalog without any profile).
 *
 *   pnpm tool list_tasks '{"format":"flat"}'
 *   pnpm tool add_task '{"caption":"Test task"}'
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { SystemMloCli } from "../src/repo/mlo-cli.js";
import { LocalMloRepository } from "../src/repo/local-mlo-repository.js";
import { createToolContext } from "../src/context.js";
import { allTools } from "../src/tools/registry.js";
import { CloudGateway } from "../src/cloud/gateway.js";
import { ensureEndpoint, residentSpawner } from "../src/cloud/endpoint.js";
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
// Attaches to the resident endpoint exactly like an MCP session, because it is
// one in every way that matters: it drives the same tools, and writes and
// bootstrap here should behave the same as they do in a client.
const endpoint = await ensureEndpoint({
  host: config.cloudHost,
  port: config.cloudPort,
  spawn: residentSpawner(fileURLToPath(new URL("../src/index.ts", import.meta.url))),
});
const ctx = createToolContext(config, new LocalMloRepository(config, new SystemMloCli(config)), cloud, endpoint);
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

/**
 * Show what this server exposes — no MCP client, no MLO profile needed.
 *
 *   pnpm tools               # every tool, grouped by kind
 *   pnpm tools list          # same
 *   pnpm tools add_task      # full schema for one tool
 *   pnpm tools --json        # the catalog as JSON
 */
import { catalog, renderDetail, renderList } from "./tool-catalog.js";

const [target] = process.argv.slice(2);

if (target === "--json") {
  console.log(JSON.stringify(catalog(true), null, 2));
} else if (!target || target === "list" || target === "--list") {
  console.log(renderList());
} else {
  const detail = renderDetail(target);
  if (!detail) {
    console.error(`unknown tool "${target}" — run \`pnpm tools\` to see them all`);
    process.exit(1);
  }
  console.log(detail);
}

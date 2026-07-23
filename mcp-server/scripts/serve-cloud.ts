/**
 * Run the cloud endpoint standalone — no MCP client attached. Useful when
 * driving the tools through `pnpm tool` or during bootstrap rehearsals: MLO's
 * proxy needs a listener on the configured port regardless of whether an MCP
 * session is alive.
 *
 *   pnpm exec tsx scripts/serve-cloud.ts
 */
import { loadConfig } from "../src/config.js";
import { CloudGateway } from "../src/cloud/gateway.js";
import { startOrAttachCloudServer } from "../src/cloud/server.js";

const config = loadConfig();
const gateway = new CloudGateway({ stateRoot: config.cloudStateRoot });
const handle = await startOrAttachCloudServer({ host: config.cloudHost, port: config.cloudPort, gateway });
if (!handle) {
  console.error("an mlo-mcp endpoint already serves this port — nothing to do");
  process.exit(0);
}
console.error(`cloud endpoint serving on http://${handle.host}:${handle.port} (state root: ${config.cloudStateRoot})`);
const stop = () => void handle.stop().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/**
 * Run the resident cloud endpoint in the foreground. Sessions normally start
 * it for themselves — detached, via the server's own entry point with
 * `--serve-cloud` — so this script exists for the times you want it attached
 * to a terminal: watching its log during a bootstrap rehearsal, or driving the
 * tools through `pnpm tool` while seeing what MLO sends.
 *
 *   pnpm exec tsx scripts/serve-cloud.ts
 *
 * Only one process can serve the port, so this refuses rather than fighting a
 * resident endpoint that is already up.
 */
import { loadCloudConfig } from "../src/config.js";
import { CloudGateway } from "../src/cloud/gateway.js";
import { startCloudServer } from "../src/cloud/server.js";

const config = loadCloudConfig();
const gateway = new CloudGateway({ stateRoot: config.cloudStateRoot });
const handle = await startCloudServer({ host: config.cloudHost, port: config.cloudPort, gateway })
  .catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `${config.cloudHost}:${config.cloudPort} is already served — a resident endpoint is running. ` +
          "Stop it first if you want this one in the foreground.",
      );
      process.exit(0);
    }
    throw error;
  });
console.error(`cloud endpoint serving on http://${handle.host}:${handle.port} (state root: ${config.cloudStateRoot})`);
const stop = () => void handle.stop().finally(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

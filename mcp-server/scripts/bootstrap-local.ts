/**
 * DEV/TESTING ONLY: arm a LOCAL-mode bootstrap window for the configured
 * profile — the endpoint becomes the cloud authority itself (replacement
 * server), which is deliberately not offered by the `cloud_bootstrap` MCP
 * tool: normal profiles always keep the vendor Cloud in the loop.
 *
 * A local-mode profile must NEVER sync against the vendor Cloud again.
 * Back up the `.ml` profile before running this.
 *
 *   pnpm exec tsx scripts/bootstrap-local.ts [--rebind]
 *
 * Then run Re-synchronize in MLO (Advanced sync, Bidirectional, no
 * exclusions) while the window is armed; check `pnpm tool cloud_status`.
 */
import { loadConfig } from "../src/config.js";
import { CloudGateway } from "../src/cloud/gateway.js";

const rebind = process.argv.includes("--rebind");
const config = loadConfig();
const gateway = new CloudGateway({ stateRoot: config.cloudStateRoot });
await gateway.ensureRoot();

const existing = await gateway.bindings.forProfile(config.dataFile);
if (existing && existing.mode !== "local" && !rebind) {
  console.error(`profile is bound in "${existing.mode}" mode — pass --rebind to switch to local (old partition is kept as evidence)`);
  process.exit(1);
}
const binding = rebind || !existing
  ? await gateway.bindings.replace(config.dataFile, "local")
  : existing;
if (binding.dataFileUID) {
  const partition = await gateway.registry.open(binding.dataFileUID, "local");
  if (await partition.lifecycle() === "ready") {
    console.error("profile is already bootstrapped and ready — pass --rebind to start a fresh partition");
    process.exit(1);
  }
}
const window = await gateway.bootstrap.arm(config.dataFile, "local");
console.log(`armed LOCAL bootstrap window for ${config.dataFile} until ${window.expiresAt}`);
console.log("In MLO: proxy on, secure connection unchecked, then Advanced -> Re-synchronize (Bidirectional, no exclusions).");
console.log("WARNING: after this bootstrap the profile must never sync against the vendor Cloud again.");

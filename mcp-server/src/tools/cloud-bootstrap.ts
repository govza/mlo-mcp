import { z } from "zod";
import { bootstrapFromVendor } from "../cloud/upstream.js";
import { defineTool, textResult } from "./shared.js";

/**
 * Bootstrap this profile's cloud partition — automatic, no mode to choose.
 *
 * The endpoint always keeps the vendor Cloud in the loop (`MLO ↔ mcp-cloud ↔
 * vendor`): using the credentials observed in the profile's own proxied sync
 * traffic (in-memory only), it pulls the vendor's complete history from
 * remote version 0 as one more sync client, validates and materializes it as
 * the read/write mirror, and binds the profile. Reads AND writes are live
 * afterwards; MLO, the vendor Cloud, and mobile stay in sync throughout.
 *
 * Preconditions: back up the `.ml` profile first, and run one ordinary MLO
 * sync through this proxy since server start (that sync is what exposes the
 * account contact and the profile's `dataFileUID`).
 *
 * The local replacement-server mode (this endpoint IS the cloud; for
 * disposable/offline test profiles only) is deliberately NOT part of this
 * tool — it is armed with the dev script `scripts/bootstrap-local.ts`.
 */
export const cloudBootstrapTool = defineTool({
  name: "cloud_bootstrap",
  title: "Bootstrap the profile's cloud partition",
  description:
    "One-time setup for cloud reads and writes: after one ordinary MLO sync through the proxy, pulls the " +
    "vendor cloud's full history automatically and binds this profile. Back up the .ml profile before the " +
    "first bootstrap.",
  inputSchema: {
    rebind: z
      .boolean()
      .optional()
      .describe(
        "Explicitly drop the current partition binding and bootstrap into a fresh one. " +
        "The old partition directory is preserved as evidence.",
      ),
  },
  outputSchema: {
    bootstrapped: z.boolean(),
    version: z.string().optional().describe("Vendor remote version the mirror was materialized at"),
    tasks: z.number().optional(),
    instructions: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async execute({ rebind }, ctx) {
    const gateway = ctx.cloud;
    if (!gateway) throw new Error("no cloud gateway is attached to this server context");
    await gateway.ensureRoot();
    const binding = rebind
      ? await gateway.bindings.replace(ctx.config.dataFile, "upstream")
      : await gateway.bindings.create(ctx.config.dataFile, "upstream");
    if (binding.dataFileUID) {
      const partition = await gateway.registry.open(binding.dataFileUID, binding.mode);
      if (await partition.lifecycle() === "ready") {
        throw new Error(
          "this profile is already bootstrapped and ready; pass { rebind: true } to discard the binding and " +
          "bootstrap into a fresh partition (the old partition stays on disk as evidence)",
        );
      }
    }

    let uid = binding.dataFileUID;
    if (!uid) {
      const candidates: string[] = [];
      for (const candidate of gateway.vendorContactUids()) {
        if (!(await gateway.bindings.forUid(candidate))) candidates.push(candidate);
      }
      if (candidates.length === 0) {
        throw new Error(
          "no vendor sync traffic observed since server start — run one ordinary sync in MLO through this " +
          'proxy ("Use secure connection" unchecked), then retry cloud_bootstrap',
        );
      }
      if (candidates.length > 1) {
        throw new Error(
          "multiple unbound dataFileUIDs have synced through this proxy — sync only the target profile, " +
          "restart the server, and retry so exactly one candidate exists",
        );
      }
      uid = candidates[0]!;
    }
    const result = await bootstrapFromVendor(gateway, ctx.config.dataFile, uid);
    const instructions =
      `Bootstrapped from the vendor cloud at remote version ${result.version} ` +
      `(${result.stats.tasks} tasks, ${result.stats.places} contexts, ${result.stats.flags} flags). ` +
      "Reads and writes are live: MCP writes go up as this endpoint's own vendor sync sessions and reach MLO " +
      "on its next QuickSync; vendor and mobile sync are unaffected.";
    return textResult(instructions, {
      bootstrapped: true,
      version: result.version,
      tasks: result.stats.tasks ?? 0,
      instructions,
    });
  },
});

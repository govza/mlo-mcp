import { z } from "zod";
import { bootstrapFromVendor } from "../cloud/upstream.js";
import { defineTool, textResult } from "./shared.js";

/**
 * Bootstrap this profile's cloud partition.
 *
 * **Upstream (default):** zero-touch. Using the vendor credentials observed
 * in the profile's own proxied sync traffic (in-memory only), the endpoint
 * pulls the vendor's complete history from remote version 0 as one more sync
 * client, validates and materializes it as the read/write mirror, and binds
 * the profile. Reads AND writes are live afterwards; MLO, the vendor Cloud,
 * and mobile stay in sync throughout. Precondition: one ordinary MLO sync
 * through this proxy since server start.
 *
 * **Local:** arms the one-time window for MLO's **Re-synchronize** (verified
 * live: confirmation-only dialog, then Get → Apply(full snapshot) → Get →
 * Release), whose upload becomes the authoritative baseline of a replacement
 * server. A local-mode profile must never sync against the vendor again.
 */
export const cloudBootstrapTool = defineTool({
  name: "cloud_bootstrap",
  title: "Bootstrap the profile's cloud partition",
  description:
    "Bootstrap this profile for cloud reads and writes. Upstream mode (default) pulls the vendor cloud's full " +
    "history automatically after one ordinary MLO sync through the proxy; local mode arms a window for MLO's " +
    "Re-synchronize and makes this endpoint the cloud authority.",
  inputSchema: {
    mode: z
      .enum(["upstream", "local"])
      .optional()
      .describe(
        'Binding authority. "upstream" (default): the real vendor Cloud stays the authority; the endpoint is a ' +
        'transparent proxy plus one more sync client, so MCP reads and writes coexist with vendor/mobile sync. ' +
        '"local": this endpoint IS the cloud — the profile must never sync against the vendor again.',
      ),
    rebind: z
      .boolean()
      .optional()
      .describe(
        "Explicitly drop the current partition binding and bootstrap into a fresh one. " +
        "The old partition directory is preserved as evidence.",
      ),
  },
  outputSchema: {
    mode: z.string(),
    bootstrapped: z.boolean().describe("true = the partition is ready now; false = a window was armed and MLO must Re-synchronize"),
    version: z.string().optional().describe("Vendor remote version the mirror was materialized at (upstream)"),
    tasks: z.number().optional(),
    armed: z.boolean().optional(),
    expiresAt: z.string().optional(),
    instructions: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async execute({ mode: requestedMode, rebind }, ctx) {
    const gateway = ctx.cloud;
    if (!gateway) throw new Error("no cloud gateway is attached to this server context");
    const mode = requestedMode ?? "upstream";
    await gateway.ensureRoot();
    const binding = rebind
      ? await gateway.bindings.replace(ctx.config.dataFile, mode)
      : await gateway.bindings.create(ctx.config.dataFile, mode);
    if (binding.mode !== mode) {
      throw new Error(
        `this profile is already bound in "${binding.mode}" mode; switching modes requires { rebind: true } ` +
        "(the old partition stays on disk as evidence)",
      );
    }
    if (binding.dataFileUID) {
      const partition = await gateway.registry.open(binding.dataFileUID, binding.mode);
      if (await partition.lifecycle() === "ready") {
        throw new Error(
          "this profile is already bootstrapped and ready; pass { rebind: true } to discard the binding and " +
          "bootstrap into a fresh partition (the old partition stays on disk as evidence)",
        );
      }
    }

    if (mode === "upstream") {
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
        mode,
        bootstrapped: true,
        version: result.version,
        tasks: result.stats.tasks ?? 0,
        instructions,
      });
    }

    const window = await gateway.bootstrap.arm(ctx.config.dataFile, mode);
    const instructions =
      "Armed (local replacement server). In MLO: make sure the cloud sync proxy points at this endpoint, then " +
      "open the profile's sync settings (Advanced) and run Re-synchronize with Bidirectional direction and no " +
      "property exclusions. MLO will pull an empty state and upload its complete database; the endpoint " +
      "validates and materializes it as the authoritative baseline. Check cloud_status afterward — lifecycle " +
      `must be "ready". WARNING: a local-mode profile must never sync against the vendor Cloud again. ` +
      `The window expires at ${window.expiresAt}.`;
    return textResult(instructions, {
      mode,
      bootstrapped: false,
      armed: true,
      expiresAt: window.expiresAt,
      instructions,
    });
  },
});

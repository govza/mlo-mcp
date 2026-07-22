import { z } from "zod";
import { defineTool, textResult } from "./shared.js";

/**
 * Arm the one-time bootstrap window that lets the profile's next MLO
 * **Re-synchronize** become the partition's authoritative full baseline.
 *
 * Verified Re-synchronize behavior (live capture): the Advanced-sync button
 * shows a confirmation only, then runs Get → Apply(full snapshot) → Get →
 * Release. Against an empty partition with Bidirectional and no exclusions,
 * MLO uploads its complete database — every task with its stable UID and
 * complete record, possibly accompanied by historical tombstones.
 */
export const cloudBootstrapTool = defineTool({
  name: "cloud_bootstrap",
  title: "Arm a full-snapshot bootstrap",
  description:
    "Arm the one-time bootstrap window for this profile: bind it to a fresh cloud state partition and accept " +
    "MLO's next Re-synchronize as the authoritative full snapshot. Local mode only; requires an empty partition.",
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
    armed: z.boolean(),
    mode: z.string(),
    expiresAt: z.string(),
    instructions: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute({ rebind }, ctx) {
    const gateway = ctx.cloud;
    if (!gateway?.partitioned) {
      throw new Error(
        "the legacy demo state dir needs no bootstrap — partitioned state (a real profile via MLO_DATA_FILE) is required",
      );
    }
    const mode = gateway.defaultMode;
    if (mode === "upstream") {
      throw new Error(
        "upstream-mode bootstrap (transparent vendor mirror) is not implemented yet; " +
        "set MLO_CLOUD_MODE=local to bootstrap this profile against the local replacement endpoint " +
        "— note that a local-mode profile must never sync against the vendor Cloud again",
      );
    }
    await gateway.ensureRoot();
    const binding = await gateway.bindings!.create(ctx.config.dataFile, mode);
    if (binding.dataFileUID) {
      const partition = await gateway.registry!.open(binding.dataFileUID);
      if (rebind) {
        await gateway.bindings!.unbindUid(ctx.config.dataFile);
      } else if (await partition.lifecycle() === "ready") {
        throw new Error(
          "this profile is already bootstrapped and ready; pass { rebind: true } to discard the binding and " +
          "bootstrap into a fresh partition (the old partition stays on disk as evidence)",
        );
      }
    }
    const window = await gateway.bootstrap!.arm(ctx.config.dataFile, mode);
    const instructions =
      "Armed. In MLO: make sure the cloud sync proxy points at this endpoint, then open the profile's " +
      "sync settings (Advanced) and run Re-synchronize with Bidirectional direction and no property exclusions. " +
      "MLO will pull an empty state and upload its complete database; the endpoint validates and materializes " +
      "it as the authoritative baseline. Check cloud_status afterward — lifecycle must be \"ready\". " +
      `The window expires at ${window.expiresAt}.`;
    return textResult(instructions, {
      armed: true,
      mode,
      expiresAt: window.expiresAt,
      instructions,
    });
  },
});

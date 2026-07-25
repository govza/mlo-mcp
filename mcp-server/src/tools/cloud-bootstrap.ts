import { z } from "zod";
import type { CloudGateway } from "../cloud/gateway.js";
import { bootstrapFromVendor } from "../cloud/upstream.js";
import { defineTool, textResult } from "./shared.js";

/**
 * dataFileUIDs seen syncing through the proxy that this profile may bootstrap
 * into: the unbound ones, plus its own current UID. The old order replaced the
 * binding before resolving candidates, which made the profile's own UID
 * unbound and therefore eligible — re-pulling the cloud file a profile is
 * already bound to stays possible now that the resolution happens first.
 */
async function bootstrapCandidates(gateway: CloudGateway, ownUid: string | undefined): Promise<string[]> {
  const candidates: string[] = [];
  for (const candidate of gateway.vendorContactUids()) {
    if (candidate === ownUid || !(await gateway.bindings.forUid(candidate))) candidates.push(candidate);
  }
  return candidates;
}

/**
 * A profile is never bound to "the last UID seen": exactly one candidate must
 * be in play, or the operator is told what to do about it.
 */
function soleCandidate(candidates: string[]): string {
  if (candidates.length === 0) {
    throw new Error(
      "no vendor sync traffic observed since server start — run one ordinary sync in MLO through this " +
      'proxy ("Use secure connection" unchecked), then retry cloud_bootstrap',
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      "multiple candidate dataFileUIDs have synced through this proxy — sync only the target profile, " +
      "restart the server, and retry so exactly one candidate exists",
    );
  }
  return candidates[0]!;
}

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
    "first bootstrap. Must run from the MCP client that owns the sync endpoint (cloud_status reports " +
    "endpointRole) — the credentials it needs are held in that process's memory only.",
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
    if (ctx.endpointRole === "attached") {
      throw new Error(
        "this MCP client is attached to a cloud endpoint owned by another process, and the vendor credentials " +
        "a bootstrap needs are held in that process's memory only — nothing was changed. Run cloud_bootstrap " +
        "from the MCP client that owns the endpoint (cloud_status reports endpointRole), or close that client " +
        "and retry here after one ordinary MLO sync",
      );
    }
    await gateway.ensureRoot();

    // Everything the bootstrap needs is resolved BEFORE the binding moves: a
    // rebind that replaced the binding first and only then discovered it had
    // no vendor contact left the profile half-repaired, harder to recover
    // from than the fault it was meant to fix.
    const existing = await gateway.bindings.forProfile(ctx.config.dataFile);
    // Kept ahead of candidate resolution so a mode conflict still reports
    // itself first, as it did when BindingStore.create() ran here.
    if (!rebind && existing && existing.mode !== "upstream") {
      throw new Error(
        `this profile is bound in "${existing.mode}" mode; switching sync authority requires an explicit ` +
        "cloud_bootstrap { rebind: true } into a fresh partition",
      );
    }
    if (!rebind && existing?.dataFileUID) {
      const partition = await gateway.registry.open(existing.dataFileUID, existing.mode);
      if (await partition.lifecycle() === "ready") {
        throw new Error(
          "this profile is already bootstrapped and ready; pass { rebind: true } to discard the binding and " +
          "bootstrap into a fresh partition (the old partition stays on disk as evidence)",
        );
      }
    }
    const uid = !rebind && existing?.dataFileUID
      ? existing.dataFileUID
      : soleCandidate(await bootstrapCandidates(gateway, existing?.dataFileUID));
    // Reached by the UID carried over from an existing binding: candidates are
    // drawn from UIDs whose contact the endpoint already holds.
    if (!gateway.vendorContact(uid)) {
      throw new Error(
        `no vendor sync traffic observed for dataFileUID ${uid} since server start — run one ordinary sync ` +
        'in MLO through this proxy ("Use secure connection" unchecked), then retry cloud_bootstrap',
      );
    }

    // Preconditions hold — from here the binding may move.
    if (rebind) await gateway.bindings.replace(ctx.config.dataFile, "upstream");
    else await gateway.bindings.create(ctx.config.dataFile, "upstream");
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

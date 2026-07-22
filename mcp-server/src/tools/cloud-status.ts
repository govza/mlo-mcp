import { z } from "zod";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { localStampToString } from "../cloud/local-stamp.js";
import { defineTool, resolveReadCloudState, textResult } from "./shared.js";

export const cloudStatusTool = defineTool({
  name: "cloud_status",
  title: "Local cloud sync status",
  description:
    "Report local cloud endpoint configuration, the profile's partition binding and bootstrap lifecycle, cursor, and delta counts.",
  inputSchema: {},
  outputSchema: {
    host: z.string(),
    port: z.number(),
    cursor: z.string(),
    entries: z.object({ mcp: z.number(), app: z.number() }),
    pendingForApp: z.number(),
    /** "unbound" before bootstrap, or the bound partition's mode. */
    mode: z.string(),
    lifecycle: z.string().optional().describe("uninitialized | bootstrap-required | ready (bound partitions only)"),
    dataFileUID: z.string().optional(),
    /** Foreign-cursor rejections: the profile synced against a different server history. */
    endpointMismatches: z.number(),
    lastLocalStamp: z.string().optional(),
    stateRoot: z.string().optional(),
    partitions: z
      .array(z.object({ key: z.string(), mode: z.string(), lifecycle: z.string() }))
      .optional(),
    mirror: z
      .object({
        entries: z.object({ uploads: z.number(), downloads: z.number() }),
        lastVendorVersion: z.string(),
        mirrorBlind: z.boolean(),
        healthy: z.boolean(),
      })
      .optional()
      .describe("Upstream-mode capture coverage (vendor stays the cursor authority)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute(_args, ctx) {
    const state = await resolveReadCloudState(ctx);
    const [cursor, entries, pendingForApp, mismatches, lastStamp] = await Promise.all([
      state.highWater(),
      state.counts(),
      state.pendingFor("app"),
      state.endpointMismatchCount(),
      state.lastLocalStamp(),
    ]);
    const gateway = ctx.cloud;
    let mode = "unpartitioned"; // only in gateway-less unit-test contexts
    let lifecycle: string | undefined;
    let dataFileUID: string | undefined;
    let partitions: { key: string; mode: string; lifecycle: string }[] | undefined;
    let mirror: { entries: { uploads: number; downloads: number }; lastVendorVersion: string; mirrorBlind: boolean; healthy: boolean } | undefined;
    if (gateway) {
      const bound = await gateway.boundPartition(ctx.config.dataFile);
      if (bound.kind === "bound") {
        mode = bound.binding.mode;
        lifecycle = bound.lifecycle;
        dataFileUID = bound.binding.dataFileUID;
        if (bound.binding.mode === "upstream") {
          const [counts, highWater, blind, healthy] = await Promise.all([
            bound.partition.mirrorState.counts(),
            bound.partition.mirrorState.highWater(),
            gateway.mirrorBlind(),
            gateway.mirrorHealthy(),
          ]);
          mirror = {
            entries: { uploads: counts.app, downloads: counts.mcp },
            lastVendorVersion: cursorToDecimalString(highWater),
            mirrorBlind: blind,
            healthy,
          };
        }
      } else {
        mode = "unbound";
        lifecycle = "uninitialized";
      }
      partitions = (await gateway.registry.list()).map((partition) => ({
        key: partition.key,
        mode: partition.mode,
        lifecycle: partition.lifecycle,
      }));
    }
    const result = {
      host: ctx.config.cloudHost,
      port: ctx.config.cloudPort,
      cursor: cursorToDecimalString(cursor),
      entries,
      pendingForApp,
      mode,
      ...(lifecycle ? { lifecycle } : {}),
      ...(dataFileUID ? { dataFileUID } : {}),
      endpointMismatches: mismatches,
      ...(lastStamp !== undefined ? { lastLocalStamp: localStampToString(lastStamp) } : {}),
      ...(gateway?.stateRoot ? { stateRoot: gateway.stateRoot } : {}),
      ...(partitions ? { partitions } : {}),
      ...(mirror ? { mirror } : {}),
    };
    const bindingNote = mode === "unbound"
      ? "no partition bound — run cloud_bootstrap"
      : `${mode} partition, ${lifecycle ?? "n/a"}`;
    const mismatchNote = mismatches
      ? `; ${mismatches} endpoint mismatch(es) — the profile synced against a different server history`
      : "";
    return textResult(
      `Cloud endpoint ${result.host}:${result.port}; ${bindingNote}; cursor ${result.cursor}; ` +
        `${result.pendingForApp} pending for app${mismatchNote}.`,
      result,
    );
  },
});

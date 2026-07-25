import { z } from "zod";
import type { BindingMismatch } from "../cloud/gateway.js";
import type { UnboundSighting } from "../cloud/sightings.js";
import { cursorToDecimalString } from "../cloud/cursor.js";
import { ENDPOINT_RECOVERY } from "../cloud/endpoint.js";
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
    dataFileUID: z.string().optional().describe("The partition this profile is BOUND to (from the binding)"),
    endpoint: z
      .object({
        url: z.string(),
        reachable: z.boolean(),
        version: z.string().optional(),
      })
      .optional()
      .describe(
        "The resident sync endpoint every session attaches to: MLO's proxy target and the only holder of the " +
          "vendor credentials. Unreachable means MLO cannot sync and writes are refused; reads still work",
      ),
    bindingMismatch: z
      .boolean()
      .describe(
        "MLO is syncing a dataFileUID other than the bound one, so the bound partition is one the app never " +
          "reads: writes are refused until the binding is repaired",
      ),
    unboundSightings: z
      .array(z.object({
        dataFileUID: z.string(),
        firstSeen: z.string(),
        lastSeen: z.string(),
        count: z.number(),
      }))
      .optional()
      .describe("dataFileUIDs seen syncing through the endpoint with no binding — what MLO actually presents"),
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
    // Probed rather than remembered: the resident process can exit between two
    // tool calls, and "is it up" is the whole question this field answers.
    const [cursor, entries, pendingForApp, mismatches, lastStamp, endpointStatus] = await Promise.all([
      state.highWater(),
      state.counts(),
      state.pendingFor("app"),
      state.endpointMismatchCount(),
      state.lastLocalStamp(),
      ctx.endpoint?.status(),
    ]);
    const endpoint = ctx.endpoint
      ? {
          url: ctx.endpoint.url,
          reachable: endpointStatus !== undefined,
          ...(endpointStatus?.version ? { version: endpointStatus.version } : {}),
        }
      : undefined;
    const gateway = ctx.cloud;
    let mode = "unpartitioned"; // only in gateway-less unit-test contexts
    let lifecycle: string | undefined;
    let dataFileUID: string | undefined;
    let sightings: UnboundSighting[] = [];
    let mismatch: BindingMismatch | undefined;
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
      // Reported beside the bound UID, never instead of it: the binding is
      // what the server acts on, the sighting is what the app actually syncs.
      [sightings, mismatch] = await Promise.all([
        gateway.unboundSightings(),
        gateway.bindingMismatch(ctx.config.dataFile),
      ]);
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
      ...(endpoint ? { endpoint } : {}),
      bindingMismatch: mismatch !== undefined,
      ...(sightings.length ? { unboundSightings: sightings } : {}),
      endpointMismatches: mismatches,
      ...(lastStamp !== undefined ? { lastLocalStamp: localStampToString(lastStamp) } : {}),
      ...(gateway?.stateRoot ? { stateRoot: gateway.stateRoot } : {}),
      ...(partitions ? { partitions } : {}),
      ...(mirror ? { mirror } : {}),
    };
    const bindingNote = mode === "unbound"
      ? "no partition bound — run cloud_bootstrap"
      : `${mode} partition, ${lifecycle ?? "n/a"}`;
    const cursorMismatchNote = mismatches
      ? `; ${mismatches} endpoint mismatch(es) — the profile synced against a different server history`
      : "";
    const bindingMismatchNote = mismatch
      ? `; BINDING MISMATCH: bound to ${mismatch.boundDataFileUID} but MLO is syncing ` +
        `${mismatch.observedDataFileUIDs.join(", ")} — writes are refused until the binding is repaired ` +
        "(cloud_bootstrap { rebind: true })"
      : "";
    // Named before the binding: an unreachable endpoint means MLO's sync has
    // nowhere to connect at all, which outranks anything about this profile.
    const endpointNote = !endpoint
      ? ""
      : endpoint.reachable
        ? `; endpoint reachable${endpoint.version ? ` (${endpoint.version})` : ""}`
        : `; ENDPOINT UNREACHABLE — MLO cannot sync through it and writes are refused. ${ENDPOINT_RECOVERY}`;
    return textResult(
      `Cloud endpoint ${result.host}:${result.port}${endpointNote}; ${bindingNote}; cursor ${result.cursor}; ` +
        `${result.pendingForApp} pending for app${cursorMismatchNote}${bindingMismatchNote}.`,
      result,
    );
  },
});

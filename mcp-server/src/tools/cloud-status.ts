import { z } from "zod";
import { ENDPOINT_RECOVERY } from "../cloud/endpoint.js";
import { defineTool, textResult, failureResult } from "./contract.js";

export const cloudStatusTool = defineTool({
  name: "cloud_status",
  title: "Local cloud sync status",
  description:
    "Report local cloud endpoint configuration, the profile's partition binding and lifecycle, and observed sync identities.",
  inputSchema: {},
  outputSchema: {
    host: z.string(),
    port: z.number(),
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
      .describe(
        "The resident sync endpoint every session attaches to: MLO's proxy target. Unreachable means MLO cannot " +
          "sync through it; reads still work",
      ),
    bindingMismatch: z
      .boolean()
      .describe(
        "MLO is syncing a dataFileUID other than the bound one, so the bound partition is one the app never reads",
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
    stateRoot: z.string(),
    partitions: z.array(z.object({ key: z.string(), mode: z.string(), lifecycle: z.string() })),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute(_args, ctx) {
    const answered = await ctx.admin.status();
    if (answered.isErrored) return failureResult(answered.failure);
    const status = answered.value;
    const result = {
      host: status.host,
      port: status.port,
      mode: status.mode,
      ...(status.lifecycle ? { lifecycle: status.lifecycle } : {}),
      ...(status.dataFileUID ? { dataFileUID: status.dataFileUID } : {}),
      endpoint: status.endpoint,
      bindingMismatch: status.mismatch !== undefined,
      ...(status.unboundSightings.length ? { unboundSightings: status.unboundSightings } : {}),
      stateRoot: status.stateRoot,
      partitions: status.partitions,
    };
    const bindingNote = status.mode === "unbound"
      ? "no partition bound"
      : `${status.mode} partition, ${status.lifecycle ?? "n/a"}`;
    const bindingMismatchNote = status.mismatch
      ? `; BINDING MISMATCH: bound to ${status.mismatch.boundDataFileUID} but MLO is syncing ` +
        `${status.mismatch.observedDataFileUIDs.join(", ")}`
      : "";
    // Named before the binding: an unreachable endpoint means MLO's sync has
    // nowhere to connect at all, which outranks anything about this profile.
    const endpointNote = status.endpoint.reachable
      ? `; endpoint reachable${status.endpoint.version ? ` (${status.endpoint.version})` : ""}`
      : `; ENDPOINT UNREACHABLE — MLO cannot sync through it. ${ENDPOINT_RECOVERY}`;
    return textResult(
      `Cloud endpoint ${result.host}:${result.port}${endpointNote}; ${bindingNote}${bindingMismatchNote}.`,
      result,
    );
  },
});

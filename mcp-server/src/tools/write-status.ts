import { z } from "zod";
import { defineTool, failureResult, textResult } from "./contract.js";

/**
 * Where one accept receipt got to (spec section 2). Separate from the write
 * tools because a write returns before its fate is known: this is the surface a
 * caller that wants to know comes back to, and it never blocks waiting.
 */
export const writeStatusTool = defineTool({
  name: "write_status",
  title: "Write status",
  description:
    "Where one accepted write got to, by its writeId. Five states: accepted (durably queued, MLO has not synced " +
    "yet), delivered (MLO applied it), verified (applied and confirmed by a fresh export), expired (MLO never " +
    "synced before the TTL — the rows are dead-lettered, nothing was applied), superseded (MLO applied its own " +
    "conflicting version instead, so this write's content is gone). Receipts age out; cloud_status carries the " +
    "recent dead letters for writes nobody was waiting on.",
  inputSchema: {
    writeId: z.string().describe("The receipt a write tool returned"),
  },
  outputSchema: {
    writeId: z.string(),
    status: z.enum(["accepted", "delivered", "verified", "expired", "superseded"]),
    uid: z.string().optional().describe("Stable GUID of the task the write addressed"),
    expiresAt: z.string().optional().describe("Present while still queued: when the write gives up"),
    at: z.string().optional().describe("When the write resolved, for every state past accepted"),
    detail: z.string(),
    remedy: z.string().optional().describe("What ends this state, when anything can"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute({ writeId }, ctx) {
    const answered = await ctx.outline.writeStatus(writeId);
    if (answered.isErrored) return failureResult(answered.failure);
    const progress = answered.value;
    const lines = [
      `${progress.writeId}: ${progress.status} — ${progress.detail}`,
      progress.uid ? `task: ${progress.uid}` : undefined,
      progress.expiresAt ? `expires: ${progress.expiresAt}` : undefined,
      progress.at ? `resolved: ${progress.at}` : undefined,
      progress.remedy ? `remedy: ${progress.remedy}` : undefined,
    ].filter(Boolean);
    return textResult(lines.join("\n"), { ...progress });
  },
});

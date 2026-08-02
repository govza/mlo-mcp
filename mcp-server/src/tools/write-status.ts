import { z } from "zod";
import type { WriteStatus } from "../repo/mlo-repository.js";
import { defineTool, failureResult, textResult } from "./contract.js";

/**
 * One sentence per state, plus what ends it where anything can. The receipt
 * itself travels verbatim from the write path; these words are added here, at
 * the last boundary before a human, because "what does superseded mean for me"
 * is a caller question no inner seam needs answered.
 */
const PROGRESS_WORDS: Record<WriteStatus, { detail: string; remedy?: string }> = {
  accepted: {
    detail: "durably queued — it lands the next time MLO syncs through the endpoint",
    remedy: "nothing to do; MLO syncs on its own within about 90 seconds, or run `sync` to hurry it",
  },
  delivered: { detail: "MLO applied this write to the profile" },
  verified: { detail: "MLO applied this write and a fresh export confirmed it" },
  expired: {
    detail: "MLO did not sync before the write's TTL ran out, so it was never applied — the rows are in the dead-letter file",
    remedy: "check MLO is running and syncing through the endpoint (`cloud_status`), then make the change again",
  },
  superseded: {
    detail:
      "MLO applied a different version of this task instead — a conflict the app resolved in favour of its own copy, " +
      "so this write's content is gone",
    remedy: "read the task again and re-apply the change on top of what MLO kept",
  },
};

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
    const receipt = answered.value;
    const words = PROGRESS_WORDS[receipt.status];
    const progress = {
      writeId: receipt.writeId,
      status: receipt.status,
      ...(receipt.uid ? { uid: receipt.uid } : {}),
      ...(receipt.expiresAt ? { expiresAt: receipt.expiresAt } : {}),
      ...(receipt.at ? { at: receipt.at } : {}),
      // The write path's own words come first when it has any: they name the
      // task and the session, which no generic sentence can.
      detail: receipt.detail ? `${receipt.detail} — ${words.detail}` : words.detail,
      ...(words.remedy ? { remedy: words.remedy } : {}),
    };
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

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AcceptReceipt, OutlineWrite } from "../services/outline.js";
import { failureResult, textResult } from "./contract.js";

/**
 * The one shape every write tool answers with (spec section 2, tool-facing
 * contract): what was accepted, the receipt to ask about it later, and when it
 * gives up. Said once so no tool can drift into promising delivery.
 *
 * The service holds the reply open for a bounded delivery wait (writeWaitMs,
 * usually enough for the QuickSync nudge to land), so `status` is whatever the
 * write path actually observed by then: "delivered"/"verified" means MLO shows
 * the change now, "accepted" means it is still queued and rides MLO's own sync
 * — a timeout is never reported as failure, and `write_status(writeId)` stays
 * the surface for the eventual outcome.
 */
export const WRITE_ACCEPT_OUTPUT = {
  uid: z.string().describe("Stable GUID of the task the write addressed — the first one, for a batch"),
  uids: z.array(z.string()).optional().describe("Every GUID the write addressed, when it addressed more than one"),
  caption: z
    .string()
    .describe(
      "Caption of the task the write resolved to — the first one, for a batch. Check it names the task you " +
        "meant: a stale path id is accepted against whatever task sits there now",
    ),
  writeId: z.string().describe("The accept receipt — pass it to write_status to see where the write got to"),
  status: z
    .enum(["accepted", "delivered", "verified", "superseded", "expired"])
    .describe(
      "Where the write stood when the delivery wait closed. delivered/verified: MLO applied it, visible in the " +
        "app now. accepted: durably queued, MLO applies it on its own sync. superseded: MLO kept its own " +
        "conflicting version — re-read and re-apply",
    ),
  expiresAt: z
    .string()
    .describe("Local ISO time this write gives up if MLO has not synced by then; it then becomes a dead letter"),
  message: z.string(),
};

/** `2026-07-27T14:35:00` -> `14:35`, for a sentence a human reads at a glance. */
function clockTime(expiresAt: string): string {
  const match = expiresAt.match(/T(\d{2}:\d{2})/);
  if (match) return match[1]!;
  const parsed = new Date(expiresAt);
  return Number.isNaN(parsed.getTime())
    ? expiresAt
    : `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
}

function outcomeMessage(receipt: AcceptReceipt, what: string, resolved: string): string {
  switch (receipt.outcome) {
    case "delivered":
    case "verified":
      return `delivered - ${what} (${resolved}) is applied and visible in MLO now.`;
    case "superseded":
      return (
        `superseded - MLO kept its own conflicting version of (${resolved}), so this write's content is gone; ` +
        `read the task again and re-apply the change on top of what MLO kept.`
      );
    case "expired":
      return `expired - ${what} (${resolved}) was never applied; the rows are in the dead-letter file.`;
    case "accepted":
      return (
        `accepted - ${what} (${resolved}) lands on MLO's next sync; ` +
        `expires at ${clockTime(receipt.expiresAt)} if MLO doesn't sync. Reads already show it, flagged pending.`
      );
  }
}

function accepted(receipt: AcceptReceipt, what: string): CallToolResult {
  // The caption is the wrong-target tell: the uid echo is machine-checkable,
  // but a human (or model) skimming the sentence recognizes a caption.
  const caption = receipt.captions[0] ?? "";
  const resolved = receipt.captions.length > 1 ? `"${caption}" +${receipt.captions.length - 1} more` : `"${caption}"`;
  const message = outcomeMessage(receipt, what, resolved);
  return textResult(`${message} [writeId ${receipt.writeId}]`, {
    uid: receipt.uids[0] ?? "",
    ...(receipt.uids.length > 1 ? { uids: receipt.uids } : {}),
    caption,
    writeId: receipt.writeId,
    status: receipt.outcome,
    expiresAt: receipt.expiresAt,
    message,
  });
}

/**
 * Every write tool's whole body after the service call: an accept becomes the
 * receipt above, a refusal becomes one sentence with its kind and remedy.
 * `what` names the change in the caller's own terms ("the new task", "3 tasks").
 */
export function acceptResult(result: OutlineWrite, what: string): CallToolResult {
  return result.isErrored ? failureResult(result.failure) : accepted(result.value, what);
}

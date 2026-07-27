import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OutlineWrite, WriteReceipt } from "../services/outline.js";
import { failureResult, textResult } from "./contract.js";

/**
 * The one shape every write tool answers with (spec section 2, tool-facing
 * contract): what was accepted, the receipt to ask about it later, and when it
 * gives up. Said once so no tool can drift into promising delivery.
 *
 * There is no `verified` boolean and no waiting: a write returns at durable
 * accept, MLO applies it on its own next sync, and `write_status(writeId)` is
 * where the five-state outcome lives. A tool that waited would either lie
 * (timeout reported as failure) or block the caller for MLO's ~90 s cadence.
 */
export const WRITE_ACCEPT_OUTPUT = {
  uid: z.string().describe("Stable GUID of the task the write addressed — the first one, for a batch"),
  uids: z.array(z.string()).optional().describe("Every GUID the write addressed, when it addressed more than one"),
  writeId: z.string().describe("The accept receipt — pass it to write_status to see where the write got to"),
  status: z.literal("accepted").describe("Durably queued. Never a claim that MLO has applied it"),
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

function accepted(receipt: WriteReceipt, what: string): CallToolResult {
  const message =
    `accepted - ${what} lands on MLO's next sync; expires at ${clockTime(receipt.expiresAt)} if MLO doesn't sync. ` +
    `Reads already show it, flagged pending.`;
  return textResult(`${message} [writeId ${receipt.writeId}]`, {
    uid: receipt.uids[0] ?? "",
    ...(receipt.uids.length > 1 ? { uids: receipt.uids } : {}),
    writeId: receipt.writeId,
    status: "accepted",
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

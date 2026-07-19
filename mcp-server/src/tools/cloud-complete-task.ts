import { z } from "zod";
import { rowValue, type KnownRow } from "../cloud/log-projection.js";
import { csvTruthy, runCloudRowUpdate, type CloudRowTarget } from "./cloud-row-update.js";
import { defineTool } from "./shared.js";

export function completionPatch(known: KnownRow, now: string): Record<string, string> {
  return {
    CompletionDateTime: now,
    LastModified: now,
    ...(csvTruthy(rowValue(known, "IsProject")) ? { ProjectStatus: "3" } : {}),
  };
}

/**
 * Completing a recurring task in MLO spawns the next occurrence; a full-row
 * rewrite through the sync loop would not, silently ending the series.
 */
export function guardNotRecurring({ id, task, known }: CloudRowTarget): void {
  const recType = rowValue(known, "RecType");
  if (csvTruthy(recType)) {
    throw new Error(
      `[${id}] "${task.Caption}" is recurring (RecType ${recType}) — completing it through the cloud path would ` +
        "bypass MLO's recurrence generation; nothing was queued; complete it in MLO instead"
    );
  }
}

export const cloudCompleteTaskTool = defineTool({
  name: "cloud_complete_task",
  title: "Complete tasks through local cloud sync",
  description:
    "Queue full-row updates marking tasks completed (sets CompletionDateTime; for projects also ProjectStatus), " +
    "trigger QuickSync, and verify in a fresh export. The whole batch travels as ONE delta. Only works for tasks " +
    "whose complete record is in the delta log (added via a cloud tool or changed in MLO since the local endpoint " +
    "took over) and refuses recurring tasks; otherwise nothing is queued — use complete_task instead.",
  inputSchema: {
    ids: z.array(z.string()).min(1).max(50).describe("Path-based task ids from list_tasks/search_tasks"),
  },
  outputSchema: {
    uids: z.array(z.string()),
    cursor: z.string(),
    verified: z.boolean(),
    message: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  execute({ ids }, ctx) {
    return runCloudRowUpdate(ctx, ids, {
      verb: "Completion",
      guard: guardNotRecurring,
      patchFor: ({ known }, now) => completionPatch(known, now),
      verified: (task) => Boolean(task.CompletionDateTime),
    });
  },
});

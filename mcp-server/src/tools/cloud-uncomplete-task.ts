import { z } from "zod";
import { rowValue, type KnownRow } from "../cloud/log-projection.js";
import { runCloudRowUpdate } from "./cloud-row-update.js";
import { defineTool } from "./shared.js";

export function reopenPatch(known: KnownRow, now: string): Record<string, string> {
  return {
    CompletionDateTime: "",
    LastModified: now,
    // complete paths set ProjectStatus 3 (completed); 0 = default/active
    ...(rowValue(known, "ProjectStatus") === "3" ? { ProjectStatus: "0" } : {}),
  };
}

export const cloudUncompleteTaskTool = defineTool({
  name: "cloud_uncomplete_task",
  title: "Reopen tasks through local cloud sync",
  description:
    "Queue full-row updates reopening completed tasks (clears CompletionDateTime; a completed project goes back " +
    "to active), trigger QuickSync, and verify in a fresh export. The whole batch travels as ONE delta. Only " +
    "works for tasks whose complete record is in the delta log (added via a cloud tool or changed in MLO since " +
    "the local endpoint took over); otherwise nothing is queued — use uncomplete_task instead.",
  inputSchema: {
    ids: z.array(z.string()).min(1).max(50)
      .describe("Path-based task ids from list_tasks/search_tasks (include completed tasks in the listing to see them)"),
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
      verb: "Reopening",
      patchFor: ({ known }, now) => reopenPatch(known, now),
      verified: (task) => !task.CompletionDateTime,
    });
  },
});

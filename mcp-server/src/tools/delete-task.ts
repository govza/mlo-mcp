import { z } from "zod";
import { WRITE_ACCEPT_OUTPUT, acceptResult } from "./accepted.js";
import { defineTool, PATH_ID_CAVEAT } from "./contract.js";

export const deleteTaskTool = defineTool({
  name: "delete_task",
  title: "Delete a task",
  description:
    "Tombstone one task AND ITS WHOLE SUBTREE — a partial tombstone would orphan the children. Every task in the " +
    "branch must resolve to its stable GUID, or nothing is queued. Returns at durable accept; reads hide the " +
    "branch immediately. There is no undo through this server: MLO's own recycle bin is the only recovery.",
  inputSchema: {
    id: z
      .string()
      .describe(
        `Path-based id or stable "{GUID}" of the task to delete (${PATH_ID_CAVEAT}) — prefer the GUID, and ` +
          "re-read before targeting by path id",
      ),
  },
  outputSchema: WRITE_ACCEPT_OUTPUT,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async execute({ id }, ctx) {
    return acceptResult(await ctx.outline.delete(id), `deleting [${id}] and its subtree`);
  },
});

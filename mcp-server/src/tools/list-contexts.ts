import { z } from "zod";
import { flatten } from "../task-tree.js";
import { defineTool, textResult } from "./shared.js";

interface RawTaskPlace {
  "@_Caption": string;
  [key: string]: unknown;
}

export const listContextsTool = defineTool({
  name: "list_contexts",
  title: "List contexts",
  description:
    "List the profile's contexts (MLO Places, e.g. @Office): the ones defined in the profile plus any " +
    "referenced by tasks, with usage counts. Consult this before assigning contexts — reuse existing ones.",
  inputSchema: {},
  outputSchema: {
    contexts: z.array(
      z.object({
        Caption: z.string(),
        defined: z.boolean().describe("Declared in the profile's places list (may carry open-hours schedules)"),
        tasksUsing: z.number(),
      })
    ),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute(_args, ctx) {
    const snap = await ctx.store.getSnapshot();
    const placesList = snap.doc["MyLifeOrganized-xml"].PlacesList as { TaskPlace?: RawTaskPlace[] } | undefined;
    const defined = (placesList?.TaskPlace ?? []).map((p) => p["@_Caption"]);

    const usage = new Map<string, number>();
    for (const t of flatten(snap.tasks)) {
      for (const p of t.Places) usage.set(p, (usage.get(p) ?? 0) + 1);
    }

    const captions = [...new Set([...defined, ...usage.keys()])];
    const contexts = captions
      .map((Caption) => ({ Caption, defined: defined.includes(Caption), tasksUsing: usage.get(Caption) ?? 0 }))
      .sort((a, b) => b.tasksUsing - a.tasksUsing || a.Caption.localeCompare(b.Caption));

    const text = contexts.length
      ? contexts
          .map((c) => `${c.Caption}  (${c.tasksUsing} task${c.tasksUsing === 1 ? "" : "s"}${c.defined ? "" : ", not in places list"})`)
          .join("\n")
      : "(no contexts defined)";
    return textResult(text, { contexts });
  },
});

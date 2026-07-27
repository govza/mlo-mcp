import { z } from "zod";
import type { TaskNode } from "./types.js";

/**
 * Machine-readable task summary used in structuredContent across tools.
 * Domain-tier DTO (ADR-0005 section 7): the one projection of a TaskNode that
 * crosses the tool boundary, kept beside the tree model it summarizes.
 */
export const TaskSummaryShape = {
  id: z.string().describe('Path-based id ("1.2.3"); stable only until the tree changes'),
  Guid: z.string().optional().describe("Internal MLO GUID (stable), when recoverable"),
  Caption: z.string(),
  completed: z.boolean(),
  IsProject: z.boolean().optional(),
  Starred: z.boolean().optional(),
  DueDateTime: z.string().optional(),
  StartDateTime: z.string().optional(),
  Importance: z.number().optional().describe("0–200; 100 = normal (omitted in MLO's XML); -iN entry maps to (N-1)*50"),
  Flag: z.string().optional(),
  Places: z.array(z.string()).describe("Contexts, e.g. @Office"),
  parentPath: z.string().describe("Captions of ancestors joined with ' > '"),
};

export const TaskSummarySchema = z.object(TaskSummaryShape);
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export function toSummary(t: TaskNode): TaskSummary {
  return {
    id: t.id,
    Guid: t.Guid,
    Caption: t.Caption,
    completed: Boolean(t.CompletionDateTime),
    IsProject: t.IsProject || undefined,
    Starred: t.Starred || undefined,
    DueDateTime: t.DueDateTime,
    StartDateTime: t.StartDateTime,
    Importance: t.Importance,
    Flag: t.Flag,
    Places: t.Places,
    parentPath: t.Path.slice(0, -1).join(" > "),
  };
}

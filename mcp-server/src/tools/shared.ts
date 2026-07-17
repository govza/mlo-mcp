import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MloConfig, TaskNode } from "../types.js";
import type { MloStore } from "../store.js";
import { log } from "../log.js";

export interface ToolContext {
  config: MloConfig;
  store: MloStore;
}

/** Machine-readable task summary used in structuredContent across tools. */
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

export function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wrap a tool handler so failures become isError results with actionable text. */
export function guard<A extends unknown[]>(
  name: string,
  fn: (...args: A) => Promise<CallToolResult>
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`${name} failed: ${message}`);
      return errorResult(`${name} failed: ${message}`);
    }
  };
}

/** Local time as MLO's ISO format (no timezone suffix): 2026-07-17T15:00:00 */
export function nowIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

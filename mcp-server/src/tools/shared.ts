import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MloConfig, TaskNode } from "../types.js";
import type { MloStore } from "../store.js";
import { log } from "../log.js";

export interface ToolContext {
  config: MloConfig;
  store: MloStore;
}

/** All four hints are mandatory so every tool states its contract explicitly. */
export interface MloToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  /**
   * Id-based write tools are NOT idempotent even when the operation looks it:
   * path ids re-resolve against the current tree, so a replayed call can hit a
   * different task.
   */
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Declarative tool definition: schemas + metadata + an execute() that is
 * callable without an MCP server (used by scripts/run-tool.ts and tests).
 */
export interface MloTool<
  In extends z.ZodRawShape = z.ZodRawShape,
  Out extends z.ZodRawShape = z.ZodRawShape,
> {
  name: string;
  title: string;
  description: string;
  inputSchema: In;
  outputSchema: Out;
  annotations: MloToolAnnotations;
  execute(args: z.objectOutputType<In, z.ZodTypeAny>, ctx: ToolContext): Promise<CallToolResult>;
}

/** Identity helper so tool literals get full inference for execute()'s args. */
export function defineTool<In extends z.ZodRawShape, Out extends z.ZodRawShape>(
  tool: MloTool<In, Out>
): MloTool<In, Out> {
  return tool;
}

/** Wire a declarative tool into the MCP server, wrapping execute() in guard(). */
export function registerTool(server: McpServer, tool: MloTool, ctx: ToolContext): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    },
    guard(tool.name, (args) => tool.execute(args, ctx))
  );
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

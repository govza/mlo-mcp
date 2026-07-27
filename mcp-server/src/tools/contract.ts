import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MloConfig } from "../types.js";
import { log } from "../log.js";
import type { OutlineService } from "../services/outline.js";
import type { NextActionsService } from "../services/next-actions.js";
import type { ReviewService } from "../services/review.js";
import type { AdminService } from "../services/admin.js";
import { failureText, type Failure } from "../result.js";

/**
 * Required services only ([spec section 1](../../../docs/adr/0005-target-architecture-spec.md)):
 * no repositories, no optional fields — the historic `ctx.cloud`-absent silent
 * downgrade is unrepresentable. Repositories are wired into services once, at
 * the composition root.
 */
export interface ToolContext {
  outline: OutlineService;
  nextActions: NextActionsService;
  review: ReviewService;
  admin: AdminService;
  config: MloConfig;
  log: (message: string) => void;
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

/**
 * Default cap on tasks returned by list_tasks/search_tasks. Results are
 * emitted twice (text + structuredContent), so an uncapped call on a large
 * profile floods the caller's context; the cap is overridable via `limit`.
 */
export const DEFAULT_RESULT_LIMIT = 200;

/**
 * Every input field that takes a Path id repeats this caveat: a client reading
 * one tool's schema never sees another's, and `instructions` is not guaranteed
 * to be surfaced at all. One constant so the copies cannot drift apart.
 */
export const PATH_ID_CAVEAT = "ids shift when the tree changes";

/**
 * `note` is the one task field that can hold *why a task exists*, and it was
 * the one field the schemas said nothing about — so a client reading schemas
 * alone had no reason to reach for it. One constant across add/update, for the
 * same anti-drift reason as PATH_ID_CAVEAT. Mechanics only: what the field
 * carries, not how to work ([ADR-0001](../../../docs/adr/0001-distribution-surfaces.md)).
 */
export const NOTE_DESCRIPTION =
  "Free-form text on the task — context that does not fit in the caption, such as where a captured idea came from";

export function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], ...(structuredContent ? { structuredContent } : {}) };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The one place a typed failure becomes prose (spec section 6). Every layer
 * below carries the refusal as a value; here it is said once, with the remedy
 * attached and the kind named so a caller can branch on it without parsing
 * the sentence.
 */
export function failureResult(failure: Failure): CallToolResult {
  return errorResult(`${failureText(failure)} [${failure.kind}]`);
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

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MloConfig, TaskNode } from "../types.js";
import type { MloStore } from "../store.js";
import { log } from "../log.js";
import type { CloudState } from "../cloud/state.js";
import type { BindingMismatch, CloudGateway } from "../cloud/gateway.js";
import type { ResidentEndpoint } from "../cloud/endpoint.js";
import { cursorToDecimalString } from "../cloud/cursor.js";

export interface ToolContext {
  config: MloConfig;
  store: MloStore;
  /** The gateway's default state (legacy demo log, or the unbound placeholder). */
  cloudState: CloudState;
  /** Partition-aware routing; absent only in old test fixtures. */
  cloud?: CloudGateway;
  /**
   * The resident endpoint this session is attached to. Every session attaches
   * and none ever listens ([ADR-0003](../../../docs/adr/0003-resident-endpoint.md)),
   * so this is not a role won at startup — it is the one process holding the
   * vendor credentials that upstream writes and bootstrap need to borrow.
   * Absent only in old test fixtures.
   */
  endpoint?: ResidentEndpoint;
}

/**
 * Cloud state for read paths (projections, GUID recovery): the bound
 * partition when one exists (upstream profiles read the vendor-versioned
 * mirror), else the empty default — reads never fail on binding state.
 * Contexts without a gateway (unit-test fixtures) use their state directly.
 */
export async function resolveReadCloudState(ctx: ToolContext): Promise<CloudState> {
  if (!ctx.cloud) return ctx.cloudState;
  const bound = await ctx.cloud.boundPartition(ctx.config.dataFile);
  if (bound.kind !== "bound") return ctx.cloudState;
  return bound.binding.mode === "upstream" ? bound.partition.mirrorState : bound.partition.state;
}

/**
 * A write path for MCP-authored deltas. `state` is the projection source for
 * lossless full-row authoring; `commit` places one envelope with the proper
 * authority — the local partition log (local mode, MLO pulls it on the next
 * QuickSync) or the endpoint's own vendor client session (upstream mode, the
 * vendor assigns the real version and MLO receives it like any remote edit).
 */
export interface CloudWriteChannel {
  state: CloudState;
  commit(bytes: Uint8Array): Promise<string>;
}

function localChannel(state: CloudState): CloudWriteChannel {
  return {
    state,
    commit: async (bytes) => cursorToDecimalString(await state.append("mcp", bytes)),
  };
}

/**
 * Phrased once in the shared write path rather than per tool, so current and
 * future write tools inherit it: a binding the app no longer syncs accepts
 * deltas into a partition nothing will ever read, and reporting queued success
 * for a change that can never arrive is worse than failing.
 */
function bindingMismatchRefusal(mismatch: BindingMismatch): Error {
  const observed = mismatch.observedDataFileUIDs.join(", ");
  return new Error(
    `binding mismatch: profile ${mismatch.profilePath} is bound to dataFileUID ` +
      `${mismatch.boundDataFileUID}, but MLO is syncing ${observed} — a delta queued into the bound ` +
      "partition could never reach the app, so nothing was queued. Either MLO has a different profile " +
      "open (sync the intended one and retry), or this profile's cloud identity changed (Re-synchronize, " +
      `a restored .ml file, a new cloud file): back up the .ml file, then run cloud_bootstrap { rebind: true } ` +
      "to bind the observed UID. Rebinding changes which sync history the profile follows and cannot be undone.",
  );
}

/**
 * What a refused write would otherwise take with it. Stated by every write
 * tool rather than left optional, so a tool cannot silently opt out of the
 * dead letter — the same reasoning that puts the refusals themselves in this
 * shared gate instead of in each tool.
 */
export interface WriteAttempt {
  /** The tool that authored the attempt, recorded beside the words. */
  tool: string;
  /** The caller's own text: captions and notes, or whatever named the targets. */
  content: string;
}

/**
 * Preserve the words of a refused write and point the caller at them.
 *
 * The write is still refused and still queues nothing — the file is a
 * consolation, not an outcome, and nothing in it is ever replayed. Applied
 * here rather than per tool so every current and future write tool inherits
 * it. See `cloud/dead-letter.ts` for why the channel, not the server, is what
 * loses the text.
 */
async function refusalAfterDeadLetter(cloud: CloudGateway, attempt: WriteAttempt, error: unknown): Promise<Error> {
  const refusal = error instanceof Error ? error : new Error(String(error));
  const store = cloud.deadLetters;
  try {
    await cloud.ensureRoot();
    await store.record({
      at: new Date().toISOString(),
      tool: attempt.tool,
      reason: refusal.message,
      content: attempt.content,
    });
  } catch (failure) {
    // The refusal is what the caller must act on; failing to save the text
    // must not replace it with a filesystem error.
    log(`could not preserve the text of a refused ${attempt.tool}: ${failure instanceof Error ? failure.message : String(failure)}`);
    return refusal;
  }
  const stated = /[.!?]$/.test(refusal.message) ? refusal.message : `${refusal.message}.`;
  return new Error(
    `${stated} The text of this write was preserved at ${store.file()} — nothing was queued, and that file is ` +
      "never replayed automatically.",
  );
}

/**
 * Resolve the write channel, failing fast — before anything is queued —
 * unless the profile's partition is bootstrapped, still the one the app
 * syncs, and, for upstream mode, the endpoint has observed the profile's
 * vendor sync traffic since server start (contacts are held in memory only).
 *
 * Any refusal preserves `attempt` on disk first; see refusalAfterDeadLetter().
 */
export async function requireWriteChannel(ctx: ToolContext, attempt: WriteAttempt): Promise<CloudWriteChannel> {
  if (!ctx.cloud) return localChannel(ctx.cloudState);
  const cloud = ctx.cloud;
  let channel: CloudWriteChannel;
  try {
    channel = await resolveWriteChannel(ctx, cloud);
  } catch (error) {
    throw await refusalAfterDeadLetter(cloud, attempt, error);
  }
  // Commit-time refusals — an unadvanced commit, rows gone stale, a vendor
  // session that vanished — lose the caller's words exactly as
  // resolution-time ones do, so the same dead-letter gate wraps the commit.
  return {
    state: channel.state,
    commit: async (bytes) => {
      try {
        return await channel.commit(bytes);
      } catch (error) {
        throw await refusalAfterDeadLetter(cloud, attempt, error);
      }
    },
  };
}

async function resolveWriteChannel(ctx: ToolContext, cloud: CloudGateway): Promise<CloudWriteChannel> {
  const bound = await cloud.boundPartition(ctx.config.dataFile);
  if (bound.kind === "unbound") {
    throw new Error(
      "this profile has no bootstrapped cloud partition; run cloud_bootstrap " +
        "(for the default upstream mode, run one sync in MLO through this proxy first so the endpoint can act " +
        "as a cloud client) — an ordinary sync alone will not help",
    );
  }
  // Before the lifecycle check: a partition the app abandoned is a different
  // fault from one that was never bootstrapped, and says so.
  const mismatch = await cloud.bindingMismatch(ctx.config.dataFile);
  if (mismatch) throw bindingMismatchRefusal(mismatch);
  if (bound.lifecycle !== "ready") {
    throw new Error(
      `cloud partition is not bootstrapped (${bound.lifecycle}); run cloud_bootstrap — an ordinary sync will not help`,
    );
  }
  if (bound.binding.mode === "local") return localChannel(bound.partition.state);
  // Upstream mode alone needs the resident endpoint: it is the only process
  // holding the profile's vendor credentials. Local mode coordinates through
  // disk and needs no contact at all.
  const endpoint = ctx.endpoint;
  if (!endpoint) {
    throw new Error(
      "upstream writes travel through the resident MLO sync endpoint, which holds the vendor credentials, and " +
        "this session is not attached to one — nothing was queued",
    );
  }
  // Refresh the mirror before authoring so full-row rewrites never start from
  // rows a mobile/vendor edit has already superseded. The endpoint holds the
  // vendor session open between here and commit(), and refuses the commit if
  // the mirror moved in between (see cloud/write-broker.ts).
  const opened = await endpoint.refreshUpstream(bound.binding.dataFileUID!);
  return {
    state: bound.partition.mirrorState,
    commit: (bytes) => endpoint.commitUpstream(opened.session, bytes),
  };
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

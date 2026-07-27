import type { MloTool } from "./contract.js";
import { listTasksTool } from "./list-tasks.js";
import { searchTasksTool } from "./search-tasks.js";
import { getTaskTool } from "./get-task.js";
import { listContextsTool } from "./list-contexts.js";
import { syncTool } from "./sync.js";
import { cloudStatusTool } from "./cloud-status.js";

/**
 * Authoritative tool registry — index.ts and scripts/run-tool.ts both iterate
 * this. Reads only, mid-re-architecture: the write tools died with the
 * projection-based write path (ADR-0005 section 7) and return with
 * OutlineService and the accept-and-return contract.
 */
export const allTools: MloTool[] = [
  listTasksTool,
  searchTasksTool,
  getTaskTool,
  listContextsTool,
  syncTool,
  cloudStatusTool,
] as MloTool[];

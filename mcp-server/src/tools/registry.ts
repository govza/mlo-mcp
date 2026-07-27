import type { MloTool } from "./contract.js";
import { listTasksTool } from "./list-tasks.js";
import { searchTasksTool } from "./search-tasks.js";
import { getTaskTool } from "./get-task.js";
import { listContextsTool } from "./list-contexts.js";
import { syncTool } from "./sync.js";
import { cloudStatusTool } from "./cloud-status.js";
import { addTaskTool } from "./add-task.js";
import { addTasksTool } from "./add-tasks.js";
import { captureTaskTool } from "./capture-task.js";
import { updateTaskTool } from "./update-task.js";
import { completeTaskTool, uncompleteTaskTool } from "./complete-task.js";
import { moveTaskTool } from "./move-task.js";
import { deleteTaskTool } from "./delete-task.js";
import { writeStatusTool } from "./write-status.js";

/**
 * Authoritative tool registry — index.ts and scripts/run-tool.ts both iterate
 * this. Every write tool answers at durable accept and nothing waits on
 * delivery; `write_status` is where a receipt's fate is read (spec section 2).
 */
export const allTools: MloTool[] = [
  listTasksTool,
  searchTasksTool,
  getTaskTool,
  listContextsTool,
  captureTaskTool,
  addTaskTool,
  addTasksTool,
  updateTaskTool,
  completeTaskTool,
  uncompleteTaskTool,
  moveTaskTool,
  deleteTaskTool,
  writeStatusTool,
  syncTool,
  cloudStatusTool,
] as MloTool[];

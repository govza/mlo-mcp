import type { MloTool } from "./shared.js";
import { listTasksTool } from "./list-tasks.js";
import { searchTasksTool } from "./search-tasks.js";
import { getTaskTool } from "./get-task.js";
import { addTaskTool } from "./add-task.js";
import { updateTaskTool } from "./update-task.js";
import { completeTaskTool } from "./complete-task.js";
import { uncompleteTaskTool } from "./uncomplete-task.js";
import { deleteTaskTool } from "./delete-task.js";
import { listContextsTool } from "./list-contexts.js";
import { syncTool } from "./sync.js";

/** Authoritative tool registry — index.ts and scripts/run-tool.ts both iterate this. */
export const allTools: MloTool[] = [
  listTasksTool,
  searchTasksTool,
  getTaskTool,
  addTaskTool,
  updateTaskTool,
  completeTaskTool,
  uncompleteTaskTool,
  deleteTaskTool,
  listContextsTool,
  syncTool,
] as MloTool[];

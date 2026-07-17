export interface TaskNode {
  /** Path-based id from depth-first position: "1", "1.2", "1.2.3" (root excluded). */
  id: string;
  /** Internal MLO GUID recovered from the .ml binary; undefined when extraction failed for this node. */
  Guid?: string;
  Caption: string;
  Note?: string;
  Importance?: number;
  Effort?: number;
  DueDateTime?: string;
  StartDateTime?: string;
  CompletionDateTime?: string;
  IsProject?: boolean;
  ProjectStatus?: number;
  Starred?: boolean;
  Flag?: string;
  Places: string[];
  EstimateMin?: number;
  EstimateMax?: number;
  TheGoal?: number;
  HideInToDo?: boolean;
  HideInToDoThisTask?: boolean;
  ScheduleType?: number;
  LeadTime?: number;
  CompleteSubTasksInOrder?: boolean;
  Children: TaskNode[];
  Path: string[];
  Depth: number;
}

export interface MloConfig {
  mloExePath: string;
  dataFile: string;
  exportDir: string;
  cacheStaleMs: number;
  /** Close the running MLO GUI for writes and relaunch it afterwards (default true). */
  autoRestartGui: boolean;
}

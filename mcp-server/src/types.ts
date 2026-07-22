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
  /** GUIDs (IDD) of tasks this task depends on (waits for). */
  DependsOn: string[];
  Children: TaskNode[];
  Path: string[];
  Depth: number;
}

export interface MloConfig {
  mloExePath: string;
  dataFile: string;
  exportDir: string;
  cacheStaleMs: number;
  /** Caption of the top-level task acting as the capture inbox, overriding <Inbox>/Inbox detection. */
  inboxCaption?: string;
  cloudHost: string;
  cloudPort: number;
  /** Private per-`dataFileUID` partitioned state root (outside the checkout, automatic). */
  cloudStateRoot: string;
}

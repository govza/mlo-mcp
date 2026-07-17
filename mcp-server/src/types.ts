export interface TaskNode {
  id: string;
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
}

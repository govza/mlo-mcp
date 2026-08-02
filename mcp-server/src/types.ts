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
  /**
   * Set by the read-your-own-writes overlay (spec section 2): this node
   * reflects a durably accepted write MLO has not applied yet, composed onto
   * the export at read time. Never persisted, never present on export truth.
   */
  pending?: true;
  /** The accept receipt behind `pending` — what `write_status` answers about. */
  writeId?: string;
}

export interface MloConfig {
  mloExePath: string;
  dataFile: string;
  /** dataFile was detected from the running MLO, not pinned by --data-file — the server follows profile switches. */
  dataFileAutoDetected?: boolean;
  exportDir: string;
  cacheStaleMs: number;
  /**
   * Minimum gap between `-QuickSync` nudges after accepted writes. MLO's own
   * client-side throttle pops a modal ("sync no more than once per several
   * minutes") when the deprecated switch fires too often; within-window writes
   * ride MLO's background GetFileTS poll instead.
   */
  quickSyncDebounceMs: number;
  /** Caption of the top-level task acting as the capture inbox, overriding <Inbox>/Inbox detection. */
  inboxCaption?: string;
  cloudHost: string;
  cloudPort: number;
  /** Private per-`dataFileUID` partitioned state root (outside the checkout, automatic). */
  cloudStateRoot: string;
}

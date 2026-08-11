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
   * Fallback only: the minimum gap between `-QuickSync` nudges when MLO's own
   * throttle counter cannot be read. The normal gate is
   * `quickSyncMaxPerWindow` against that counter.
   */
  quickSyncDebounceMs: number;
  /**
   * How much of MLO's own `-QuickSync` budget a nudge may spend. MLO counts
   * invocations per window in its settings and the one that reaches 5 pops the
   * throttle modal, hangs the CLI and syncs nothing (measured against 6.1.3),
   * so the default stops at 4 and leaves interactive `sync` calls the headroom.
   */
  quickSyncMaxPerWindow: number;
  /** Caption of the top-level task acting as the capture inbox, overriding <Inbox>/Inbox detection. */
  inboxCaption?: string;
  cloudHost: string;
  cloudPort: number;
  /** Private per-`dataFileUID` partitioned state root (outside the checkout, automatic). */
  cloudStateRoot: string;
}

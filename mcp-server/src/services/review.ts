import type { TaskNode } from "../types.js";
import type { ReadRepository } from "../repo/mlo-repository.js";
import { containerKind, findInbox, flatten, isCompleted } from "../task-tree.js";
import { AvailabilityEngine } from "./availability.js";
import { failed, ok, type ServiceResult } from "../result.js";
import type { ReadFailure } from "./failures.js";

/**
 * A container the outline itself declares — a project or a folder (see
 * `containerKind`) — with the work nested under it. Named for the flag that
 * declares it, not "branch": in the availability engine a *branch* is any task
 * with open subtasks, which is a different set.
 */
export interface Container {
  task: TaskNode;
  kind: "project" | "folder";
  /**
   * MLO's manual project status code, when the profile carries one. Never
   * auto-advances, which is exactly why a review lists it. Left as MLO's own
   * number: this server has not verified the code-to-name mapping.
   */
  status?: number;
  /** Open tasks nested anywhere under the container, in outline order. */
  tasks: TaskNode[];
  /** How many of those the To-Do list would offer right now — zero means the container is stalled. */
  availableActions: number;
  /** Completed tasks under the container, for a done-versus-open read. */
  completed: number;
}

export interface ContainerQuery {
  kind?: "project" | "folder";
  /** MLO's manual project status code. */
  status?: number;
  /** Default false: a completed container is not review material. */
  includeCompleted?: boolean;
}

/**
 * Reflect: surface everything that erodes trust in the system
 * ([spec section 3](../../../docs/adr/0005-target-architecture-spec.md)).
 * Read-only, same prohibitions as `NextActionsService`, and it shares that
 * service's availability computation through the internal engine rather than
 * calling it (services never call each other).
 *
 * Deliberately two queries: the spec's `reviewDue()` / `somedayMaybe()` /
 * `waitingFor()` / `goals()` / `completedLog()` / `hygiene()` arrive when a
 * tool needs them.
 */
export class ReviewService {
  constructor(
    private readonly repo: ReadRepository,
    private readonly options: { inboxCaption?: string; now?: () => Date } = {}
  ) {}

  /** Unclarified captures: the open tasks filed directly under the inbox node. */
  async inbox(): Promise<ServiceResult<TaskNode[], ReadFailure>> {
    const read = await this.repo.snapshot();
    if (read.isErrored) return failed(read.failure);
    const inbox = findInbox(read.value.tasks, this.options.inboxCaption);
    if (!inbox) return ok([]);
    return ok(inbox.Children.filter((t) => !isCompleted(t)));
  }

  /** The outline's project and folder containers with the tasks nested under each. */
  async projects(query: ContainerQuery = {}): Promise<ServiceResult<Container[], ReadFailure>> {
    const read = await this.repo.snapshot();
    if (read.isErrored) return failed(read.failure);
    const snapshot = read.value;
    const engine = new AvailabilityEngine(snapshot, { now: this.options.now?.() });

    return ok(flatten(snapshot.tasks)
      .filter((t) => query.includeCompleted || !isCompleted(t))
      .flatMap((task) => {
        const kind = containerKind(task);
        if (!kind) return [];
        if (query.kind && query.kind !== kind) return [];
        if (query.status !== undefined && task.ProjectStatus !== query.status) return [];

        const nested = flatten(task.Children);
        const open = nested.filter((t) => !isCompleted(t));
        return [
          {
            task,
            kind,
            status: task.ProjectStatus,
            tasks: open,
            availableActions: open.filter((t) => engine.of(t.id)?.available).length,
            completed: nested.length - open.length,
          },
        ];
      }));
  }
}

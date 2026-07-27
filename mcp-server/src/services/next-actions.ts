import type { TaskNode } from "../types.js";
import type { ReadRepository } from "../repo/mlo-repository.js";
import { AvailabilityEngine, type Block } from "./availability.js";
import { failed, ok, type ServiceResult } from "../result.js";
import type { ReadFailure } from "./failures.js";

export interface NextAction {
  task: TaskNode;
  /** Approximated computed-score priority — the list is already sorted by it. */
  score: number;
  /** Nothing defers this action right now. */
  available: boolean;
  /** Why it is deferred; empty when available. Only ever populated with `availableOnly: false`. */
  blocks: Block[];
}

export interface NextActionsQuery {
  /** Context (MLO Place) to filter by, with or without the leading @. Hierarchical: a parent context reaches the contexts it includes. */
  context?: string;
  /** Clock-time budget in minutes; a task with no estimate at all always fits. */
  maxTimeMin?: number;
  /** MLO's 0–200 effort slider; a task without an explicit Effort counts as 100 (normal). */
  maxEffort?: number;
  /** Default true: deferred actions (blocked, not started, context closed) are left out. */
  availableOnly?: boolean;
  limit?: number;
}

/** MLO stores its time-required estimates as fractional days. */
const MINUTES_PER_DAY = 1440;

/**
 * The clock time a task will take, in minutes, or undefined when the profile
 * estimates neither bound. "What can I do in 15 minutes" asks what *fits*, so
 * the pessimistic bound decides whenever MLO has one: a 10-to-120-minute task
 * does not belong in a 15-minute gap.
 */
function estimatedMinutes(t: TaskNode): number | undefined {
  const days = t.EstimateMax ?? t.EstimateMin;
  return days === undefined ? undefined : days * MINUTES_PER_DAY;
}

/**
 * Engage: compute the To-Do list an MLO user would see
 * ([spec section 3](../../../docs/adr/0005-target-architecture-spec.md)).
 * Read-only — it knows nothing of the write channel, identity, or the vendor
 * protocol; the leaf rule and every deferral live in the shared internal
 * `AvailabilityEngine`, so this service is only the query surface over it.
 *
 * Deliberately one method: the spec's `today()` / `forecast(date)` /
 * `starred()` arrive when a tool needs them.
 */
export class NextActionsService {
  constructor(
    private readonly repo: ReadRepository,
    private readonly options: { now?: () => Date } = {}
  ) {}

  /** Ranked next actions, highest computed score first. */
  async nextActions(query: NextActionsQuery = {}): Promise<ServiceResult<NextAction[], ReadFailure>> {
    const read = await this.repo.snapshot();
    if (read.isErrored) return failed(read.failure);
    const engine = new AvailabilityEngine(read.value, { now: this.options.now?.() });
    const availableOnly = query.availableOnly ?? true;

    const matches = engine.actions().filter((entry) => {
      if (availableOnly && !entry.available) return false;
      if (query.context !== undefined && !engine.inContext(entry, query.context)) return false;
      if (query.maxTimeMin !== undefined) {
        const minutes = estimatedMinutes(entry.task);
        if (minutes !== undefined && minutes > query.maxTimeMin) return false;
      }
      if (query.maxEffort !== undefined && (entry.task.Effort ?? 100) > query.maxEffort) return false;
      return true;
    });

    return ok(
      matches
        .slice(0, query.limit ?? matches.length)
        .map(({ task, score, available, blocks }) => ({ task, score, available, blocks })),
    );
  }
}

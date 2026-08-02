import { describe, it, expect } from "vitest";
import { collectVisible, searchTasks } from "../../src/task-tree.js";
import { listTasksTool } from "../../src/tools/list-tasks.js";
import { searchTasksTool } from "../../src/tools/search-tasks.js";
import { listNextActionsTool } from "../../src/tools/list-next-actions.js";
import { NextActionsService } from "../../src/services/next-actions.js";
import type { ToolContext } from "../../src/tools/contract.js";
import { OutlineService } from "../../src/services/outline.js";
import { IdentityService } from "../../src/services/identity.js";
import { EMPTY_ROW_STORE_VIEW } from "../../src/cloud/row-store.js";
import { FakeMloRepository } from "../fakes/fake-mlo-repository.js";
import type { TaskNode } from "../../src/types.js";

function task(id: string, caption: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    Caption: caption,
    Places: [],
    DependsOn: [],
    Children: [],
    Depth: id.split(".").length - 1,
    ...extra,
    Path: [...(extra.Path ?? []), caption],
  } as TaskNode;
}

/** 1 root with 2 children, one child has a grandchild; second root completed with an open child. */
function fixture(): TaskNode[] {
  const grandchild = task("1.1.1", "grandchild", { Path: ["root", "child a"] });
  const childA = task("1.1", "child a", { Path: ["root"], Children: [grandchild] });
  const childB = task("1.2", "child b", { Path: ["root"] });
  const root = task("1", "root", { Children: [childA, childB] });
  const doneChild = task("2.1", "open under done", { Path: ["done root"] });
  const doneRoot = task("2", "done root", { CompletionDateTime: "2026-01-01T00:00:00", Children: [doneChild] });
  return [root, doneRoot];
}

function fakeCtx(tasks: TaskNode[]): ToolContext {
  const repo = new FakeMloRepository();
  repo.tasks = tasks;
  const outline = new OutlineService(repo, new IdentityService(EMPTY_ROW_STORE_VIEW));
  const nextActions = new NextActionsService(repo);
  return { config: {}, outline, nextActions } as unknown as ToolContext;
}

describe("collectVisible", () => {
  it("prunes completed subtrees entirely by default", () => {
    const ids = collectVisible(fixture()).map((e) => e.task.id);
    expect(ids).toEqual(["1", "1.1", "1.1.1", "1.2"]);
  });

  it("includes completed subtrees when asked", () => {
    const ids = collectVisible(fixture(), { includeCompleted: true }).map((e) => e.task.id);
    expect(ids).toEqual(["1", "1.1", "1.1.1", "1.2", "2", "2.1"]);
  });

  it("cuts descendants past maxDepth and reports depths", () => {
    const entries = collectVisible(fixture(), { maxDepth: 2 });
    expect(entries.map((e) => e.task.id)).toEqual(["1", "1.1", "1.2"]);
    expect(entries.map((e) => e.depth)).toEqual([0, 1, 1]);
  });
});

describe("list_tasks", () => {
  it("keeps structuredContent in lockstep with the maxDepth-limited outline", async () => {
    const res = await listTasksTool.execute({ maxDepth: 2 }, fakeCtx(fixture()));
    const structured = res.structuredContent as { tasks: { id: string }[]; total: number };
    expect(structured.tasks.map((t) => t.id)).toEqual(["1", "1.1", "1.2"]);
    expect(structured.total).toBe(3);
    expect((res.content[0] as { text: string }).text).not.toContain("grandchild");
  });

  it("truncates at limit in both outputs and says so", async () => {
    const res = await listTasksTool.execute({ limit: 2 }, fakeCtx(fixture()));
    const structured = res.structuredContent as { tasks: { id: string }[]; total: number };
    expect(structured.tasks.map((t) => t.id)).toEqual(["1", "1.1"]);
    expect(structured.total).toBe(4);
    expect((res.content[0] as { text: string }).text).toContain("showing 2 of 4 tasks");
  });

  it("returns everything untruncated below the cap, with no note", async () => {
    const res = await listTasksTool.execute({}, fakeCtx(fixture()));
    const structured = res.structuredContent as { tasks: { id: string }[]; total: number };
    expect(structured.tasks).toHaveLength(4);
    expect(structured.total).toBe(4);
    expect((res.content[0] as { text: string }).text).not.toContain("showing");
  });
});

describe("searchTasks filters", () => {
  /** Importance is MLO's 0–200 scale; tasks at the normal 100 omit the element entirely. */
  const tasks = [
    task("1", "normal implicit"),
    task("2", "below normal", { Importance: 50 }),
    task("3", "critical", { Importance: 175, Starred: true }),
    task("4", "errand", { Places: ["@Town"], DueDateTime: "2026-07-21T09:00:00" }),
    task("5", "someday", { DueDateTime: "2026-09-01T00:00:00" }),
  ];

  it("treats a task without explicit Importance as normal (100)", () => {
    const captions = searchTasks(tasks, { minImportance: 100 }).map((t) => t.Caption);
    expect(captions).toEqual(["normal implicit", "critical", "errand", "someday"]);
  });

  it("filters above normal on the 0–200 scale", () => {
    expect(searchTasks(tasks, { minImportance: 150 }).map((t) => t.Caption)).toEqual(["critical"]);
  });

  it("matches contexts with or without the leading @", () => {
    expect(searchTasks(tasks, { context: "town" }).map((t) => t.Caption)).toEqual(["errand"]);
    expect(searchTasks(tasks, { context: "@Town" }).map((t) => t.Caption)).toEqual(["errand"]);
  });

  it("applies strict due-date bounds", () => {
    expect(searchTasks(tasks, { dueBefore: "2026-08-01" }).map((t) => t.Caption)).toEqual(["errand"]);
    expect(searchTasks(tasks, { dueAfter: "2026-07-21T09:00:00" }).map((t) => t.Caption)).toEqual(["someday"]);
  });

  it("filters starred tasks", () => {
    expect(searchTasks(tasks, { starred: true }).map((t) => t.Caption)).toEqual(["critical"]);
  });
});

describe("search_tasks", () => {
  it("caps matches at limit and reports the full total", async () => {
    const res = await searchTasksTool.execute({ query: "child", limit: 1 }, fakeCtx(fixture()));
    const structured = res.structuredContent as { tasks: { id: string }[]; total: number };
    expect(structured.tasks).toHaveLength(1);
    expect(structured.total).toBe(3); // child a, grandchild, child b
    expect((res.content[0] as { text: string }).text).toContain("showing 1 of 3 matches");
  });
});

describe("list_next_actions", () => {
  /** A sequential project, a hidden branch, an overdue leaf and a future-start leaf. */
  function actionsFixture(): TaskNode[] {
    const first = task("1.1", "first in order", { Path: ["project"] });
    const second = task("1.2", "second in order", { Path: ["project"] });
    const project = task("1", "project", { IsProject: true, CompleteSubTasksInOrder: true, Children: [first, second] });
    const buried = task("2.1", "buried", { Path: ["archive"] });
    const archive = task("2", "archive", { HideInToDo: true, Children: [buried] });
    const overdue = task("3", "overdue errand", { DueDateTime: "2000-01-01T09:00:00" });
    const later = task("4", "starts later", { StartDateTime: "2099-01-01T09:00:00" });
    return [project, archive, overdue, later];
  }

  it("returns only available leaves by default: in-order head and overdue, never hidden or deferred", async () => {
    const res = await listNextActionsTool.execute({}, fakeCtx(actionsFixture()));
    const structured = res.structuredContent as { actions: { Caption: string; score: number; blocks?: unknown }[]; total: number };
    expect(structured.actions.map((a) => a.Caption)).toEqual(
      expect.arrayContaining(["first in order", "overdue errand"]),
    );
    expect(structured.actions.map((a) => a.Caption)).not.toEqual(
      expect.arrayContaining(["second in order", "buried", "starts later", "project"]),
    );
    expect(structured.actions.every((a) => a.blocks === undefined)).toBe(true);
    expect(structured.actions.every((a) => typeof a.score === "number")).toBe(true);
  });

  it("availableOnly: false adds deferred actions with their blocks, in text and structured output", async () => {
    const res = await listNextActionsTool.execute({ availableOnly: false }, fakeCtx(actionsFixture()));
    const structured = res.structuredContent as { actions: { Caption: string; blocks?: { kind: string }[] }[] };
    const later = structured.actions.find((a) => a.Caption === "starts later");
    expect(later?.blocks?.map((b) => b.kind)).toEqual(["starts-later"]);
    expect(structured.actions.map((a) => a.Caption)).not.toContain("buried");
    expect((res.content[0] as { text: string }).text).toContain("deferred: starts 2099-01-01T09:00:00");
  });

  it("caps at limit and reports the full total", async () => {
    const res = await listNextActionsTool.execute({ limit: 1 }, fakeCtx(actionsFixture()));
    const structured = res.structuredContent as { actions: unknown[]; total: number };
    expect(structured.actions).toHaveLength(1);
    expect(structured.total).toBeGreaterThan(1);
    expect((res.content[0] as { text: string }).text).toContain("showing 1 of");
  });
});

/**
 * The tool layer is the only place a failure becomes prose (spec section 6):
 * everything below carries the refusal as a value, and it is said once here,
 * with the remedy attached and the kind named for a caller that wants to
 * branch rather than read.
 */
describe("failures become prose exactly once, at the tool boundary", () => {
  function ctxWithFailingExport(): ToolContext {
    const repo = new FakeMloRepository();
    repo.exportFails = "mlo.exe is busy";
    const outline = new OutlineService(repo, new IdentityService(EMPTY_ROW_STORE_VIEW));
    return { config: {}, outline } as unknown as ToolContext;
  }

  it("carries a read refusal out as an isError result naming the kind and the remedy", async () => {
    const res = await listTasksTool.execute({}, ctxWithFailingExport());
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("mlo.exe is busy");
    expect(text).toContain("[snapshot-unavailable]");
    // detail — remedy, in that order: the refusal, then what ends it.
    expect(text).toMatch(/mlo\.exe is busy — .+ \[snapshot-unavailable\]$/);
  });

  it("an id that resolves to nothing refuses target-unresolvable rather than answering empty", async () => {
    const res = await listTasksTool.execute({ parentId: "9.9" }, fakeCtx(fixture()));
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("[target-unresolvable]");
  });

  it("search refuses with the same kind rather than an empty match list", async () => {
    const res = await searchTasksTool.execute({}, ctxWithFailingExport());
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("[snapshot-unavailable]");
  });
});

import { describe, it, expect } from "vitest";
import { collectVisible, searchTasks } from "../../src/task-tree.js";
import { listTasksTool } from "../../src/tools/list-tasks.js";
import { searchTasksTool } from "../../src/tools/search-tasks.js";
import type { ToolContext } from "../../src/tools/shared.js";
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
  return { config: {}, store: { getSnapshot: async () => ({ tasks }) } } as unknown as ToolContext;
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

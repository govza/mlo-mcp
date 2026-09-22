import { describe, it, expect } from "vitest";
import { AvailabilityEngine } from "../../src/services/availability.js";
import { expandContext, isOpenAt, readPlaces } from "../../src/places.js";
import type { MloDocument } from "../../src/xml.js";
import type { TaskNode } from "../../src/types.js";

function task(id: string, caption: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    Caption: caption,
    Places: [],
    DependsOn: [],
    Children: [],
    Depth: id.split(".").length - 1,
    Path: [caption],
    ...extra,
  } as TaskNode;
}

const EMPTY_DOC: MloDocument = {
  "MyLifeOrganized-xml": { "@_ver": "1.2", TaskTree: { TaskNode: [] } },
};

function docWithPlaces(places: unknown): MloDocument {
  return {
    "MyLifeOrganized-xml": { "@_ver": "1.2", TaskTree: { TaskNode: [] }, PlacesList: { TaskPlace: places } },
  } as MloDocument;
}

const NOW = new Date("2026-07-27T10:00:00"); // a Monday, 10:00 local

function engine(tasks: TaskNode[], doc: MloDocument = EMPTY_DOC): AvailabilityEngine {
  return new AvailabilityEngine({ tasks, doc }, { now: NOW });
}

function blockKinds(e: AvailabilityEngine, id: string): string[] {
  const entry = e.all().find((a) => a.task.id === id);
  if (!entry) throw new Error(`no task ${id}`);
  return entry.blocks.map((b) => b.kind);
}

describe("AvailabilityEngine — leaf visibility", () => {
  it("shows leaves and not the branches above them", () => {
    const leaf = task("1.1", "call the plumber");
    const branch = task("1", "fix the kitchen", { Children: [leaf] });
    expect(engine([branch]).actions().map((a) => a.task.id)).toEqual(["1.1"]);
    expect(blockKinds(engine([branch]), "1")).toEqual(["branch"]);
  });

  it("promotes a branch to an action once its last child is completed", () => {
    const done = task("1.1", "done child", { CompletionDateTime: "2026-07-01T09:00:00" });
    const branch = task("1", "fix the kitchen", { Children: [done] });
    expect(engine([branch]).actions().map((a) => a.task.id)).toEqual(["1"]);
  });

  it("never shows a Folder, even with every child completed", () => {
    const done = task("1.1", "done child", { CompletionDateTime: "2026-07-01T09:00:00" });
    const folder = task("1", "Areas", { HideInToDoThisTask: true, Children: [done] });
    expect(engine([folder]).actions()).toEqual([]);
    expect(blockKinds(engine([folder]), "1")).toEqual(["folder"]);
  });

  it("hides a hide-in-todo branch and everything under it", () => {
    const leaf = task("1.1", "someday leaf");
    const branch = task("1", "Someday/Maybe", { HideInToDo: true, Children: [leaf] });
    expect(engine([branch]).actions()).toEqual([]);
    expect(blockKinds(engine([branch]), "1.1")).toEqual(["hidden"]);
  });

  it("excludes completed tasks from the action list", () => {
    const leaf = task("1", "already done", { CompletionDateTime: "2026-07-01T09:00:00" });
    expect(engine([leaf]).actions()).toEqual([]);
    expect(blockKinds(engine([leaf]), "1")).toEqual(["completed"]);
  });

  it("excludes unfinished children of a completed parent", () => {
    const leaf = task("1.1", "stale child");
    const parent = task("1", "completed project", { CompletionDateTime: "2026-07-01T09:00:00", Children: [leaf] });
    expect(engine([parent]).actions()).toEqual([]);
    expect(blockKinds(engine([parent]), "1.1")).toEqual(["completed"]);
  });

  it("treats a completed project status as completion for its descendants", () => {
    const leaf = task("1.1", "stale child");
    const parent = task("1", "completed project", { IsProject: true, ProjectStatus: 3, Children: [leaf] });
    expect(engine([parent]).actions()).toEqual([]);
    expect(blockKinds(engine([parent]), "1.1")).toEqual(["completed"]);
  });

  it("shows only the next incomplete subtask when the parent is sequential", () => {
    const first = task("1.1", "step one");
    const second = task("1.2", "step two");
    const branch = task("1", "checklist", { CompleteSubTasksInOrder: true, Children: [first, second] });
    expect(engine([branch]).actions().map((a) => a.task.id)).toEqual(["1.1"]);
    expect(blockKinds(engine([branch]), "1.2")).toEqual(["out-of-order"]);
  });

  it("holds back the subtasks of a step the sequential parent is still deferring", () => {
    const nested = task("1.2.1", "step two, part one");
    const first = task("1.1", "step one");
    const second = task("1.2", "step two", { Children: [nested] });
    const branch = task("1", "checklist", { CompleteSubTasksInOrder: true, Children: [first, second] });
    expect(engine([branch]).actions().map((a) => a.task.id)).toEqual(["1.1"]);
    expect(blockKinds(engine([branch]), "1.2.1")).toEqual(["out-of-order"]);
  });

  it("moves a sequential branch on once the earlier step is completed", () => {
    const first = task("1.1", "step one", { CompletionDateTime: "2026-07-01T09:00:00" });
    const second = task("1.2", "step two");
    const branch = task("1", "checklist", { CompleteSubTasksInOrder: true, Children: [first, second] });
    expect(engine([branch]).actions().map((a) => a.task.id)).toEqual(["1.2"]);
  });
});

describe("AvailabilityEngine — deferral", () => {
  it("blocks a task whose dependency is still open, and clears when it completes", () => {
    const blocker = task("1", "paint the door", { Guid: "{AAA}" });
    const waiter = task("2", "hang wallpaper", { DependsOn: ["{aaa}"] });
    expect(blockKinds(engine([blocker, waiter]), "2")).toEqual(["blocked-by-dependency"]);
    expect(engine([blocker, waiter]).actions().filter((a) => a.available).map((a) => a.task.id)).toEqual(["1"]);

    const completed = task("1", "paint the door", { Guid: "{AAA}", CompletionDateTime: "2026-07-01T09:00:00" });
    expect(blockKinds(engine([completed, waiter]), "2")).toEqual([]);
  });

  it("does not block on a dependency whose target the export never carried", () => {
    const waiter = task("1", "hang wallpaper", { DependsOn: ["{missing}"] });
    expect(blockKinds(engine([waiter]), "1")).toEqual([]);
  });

  it("defers a task whose start date has not arrived and releases it once it has", () => {
    const later = task("1", "later", { StartDateTime: "2026-08-01T09:00:00" });
    const started = task("2", "started", { StartDateTime: "2026-07-01T09:00:00" });
    const e = engine([later, started]);
    expect(blockKinds(e, "1")).toEqual(["starts-later"]);
    expect(blockKinds(e, "2")).toEqual([]);
  });

  it("defers a task whose every context is closed right now", () => {
    const doc = docWithPlaces([
      { "@_Caption": "@Office", Open: { "@_Days": "MO TU WE TH FR", "@_StartTime": "09:00:00", "@_EndTime": "17:00:00" } },
      { "@_Caption": "@Shops", Open: { "@_Days": "SA", "@_StartTime": "09:00:00", "@_EndTime": "17:00:00" } },
    ]);
    const atWork = task("1", "at work", { Places: ["@Office"] });
    const shopping = task("2", "shopping", { Places: ["@Shops"] });
    const either = task("3", "either", { Places: ["@Shops", "@Office"] });
    const e = engine([atWork, shopping, either], doc);
    expect(blockKinds(e, "1")).toEqual([]);
    expect(blockKinds(e, "2")).toEqual(["context-closed"]);
    expect(blockKinds(e, "3")).toEqual([]);
  });

  it("reports every reason a task is unavailable, not just the first", () => {
    const blocker = task("1", "blocker", { Guid: "{AAA}" });
    const waiter = task("2", "waits and waits", {
      Guid: "{BBB}",
      DependsOn: ["{AAA}"],
      StartDateTime: "2026-08-01T09:00:00",
    });
    expect(blockKinds(engine([blocker, waiter]), "2")).toEqual(["blocked-by-dependency", "starts-later"]);
  });
});

describe("AvailabilityEngine — ranking", () => {
  it("multiplies relative importance down the branch", () => {
    const leaf = task("1.1", "leaf", { Importance: 200 });
    const branch = task("1", "dragged down", { Importance: 50, Children: [leaf] });
    const entry = engine([branch]).all().find((a) => a.task.id === "1.1");
    expect(entry?.importance).toBeCloseTo(100); // 100 × 0.5 × 2.0
  });

  it("treats a missing Importance as normal", () => {
    const entry = engine([task("1", "plain")]).all()[0];
    expect(entry.importance).toBeCloseTo(100);
  });

  it("ranks an overdue task above an equally important one that is not due", () => {
    const overdue = task("1", "overdue", { DueDateTime: "2026-07-20T09:00:00" });
    const undated = task("2", "undated");
    const ranked = engine([overdue, undated]).actions();
    expect(ranked.map((a) => a.task.id)).toEqual(["1", "2"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("sinks a task that cannot be due for months below an undated one", () => {
    const ranked = engine([task("1", "far off", { DueDateTime: "2026-12-01T09:00:00" }), task("2", "undated")]).actions();
    expect(ranked.map((a) => a.task.id)).toEqual(["2", "1"]);
  });

  it("lifts a task the longer it has been startable", () => {
    const waiting = task("1", "startable for weeks", { StartDateTime: "2026-06-01T09:00:00" });
    const fresh = task("2", "startable today", { StartDateTime: "2026-07-27T09:00:00" });
    const ranked = engine([fresh, waiting]).actions();
    expect(ranked.map((a) => a.task.id)).toEqual(["1", "2"]);
  });

  it("ranks doable work above deferred work whatever the scores say", () => {
    const deferred = task("1", "important but blocked", { Importance: 200, StartDateTime: "2026-08-01T09:00:00" });
    const doable = task("2", "plain but doable");
    const ranked = engine([deferred, doable]).actions();
    expect(ranked.map((a) => a.task.id)).toEqual(["2", "1"]);
    expect(ranked[1].score).toBeGreaterThan(ranked[0].score);
  });

  it("ranks a more important task first when neither has dates", () => {
    const ranked = engine([task("1", "normal"), task("2", "critical", { Importance: 175 })]).actions();
    expect(ranked.map((a) => a.task.id)).toEqual(["2", "1"]);
  });
});

describe("AvailabilityEngine — contexts", () => {
  const doc = docWithPlaces([
    { "@_Caption": "@Home", Includes: [{ "@_Place": "Phone" }, { "@_Place": "Internet" }] },
    { "@_Caption": "Phone" },
    { "@_Caption": "Internet" },
  ]);

  it("matches a task through the contexts its filter includes", () => {
    const call = task("1", "call mum", { Places: ["Phone"] });
    const e = engine([call], doc);
    const entry = e.all()[0];
    expect(e.inContext(entry, "@Home")).toBe(true);
    expect(e.inContext(entry, "Home")).toBe(true);
    expect(e.inContext(entry, "Internet")).toBe(false);
  });

  it("does not match a task with no contexts at all", () => {
    const e = engine([task("1", "untagged")], doc);
    expect(e.inContext(e.all()[0], "@Home")).toBe(false);
  });
});

describe("places", () => {
  it("reads open windows and includes from the profile's places list", () => {
    const places = readPlaces(
      docWithPlaces([
        {
          "@_Caption": "@Home",
          Open: [
            { "@_Days": "MO TU WE TH FR", "@_StartTime": "17:00:00", "@_EndTime": "22:30:00" },
            { "@_Days": "SU SA", "@_StartTime": "05:00:00", "@_EndTime": "22:30:00" },
          ],
          Includes: { "@_Place": "HomeCalls" },
        },
        { "@_Caption": "Internet" },
      ])
    );
    expect(places).toHaveLength(2);
    expect(places[0].open).toHaveLength(2);
    expect(places[0].includes).toEqual(["HomeCalls"]);
    expect(places[1].open).toEqual([]);
  });

  it("treats a context with no declared hours as always open", () => {
    expect(isOpenAt({ Caption: "Internet", open: [], includes: [] }, NOW)).toBe(true);
    expect(isOpenAt(undefined, NOW)).toBe(true);
  });

  it("reads a places list that the parser collapsed to a single element", () => {
    const places = readPlaces(docWithPlaces({ "@_Caption": "Internet" }));
    expect(places.map((p) => p.Caption)).toEqual(["Internet"]);
  });

  it("terminates on a cycle between including contexts", () => {
    const places = readPlaces(
      docWithPlaces([
        { "@_Caption": "A", Includes: { "@_Place": "B" } },
        { "@_Caption": "B", Includes: { "@_Place": "A" } },
      ])
    );
    expect([...expandContext(places, "A")].sort()).toEqual(["a", "b"]);
  });
});

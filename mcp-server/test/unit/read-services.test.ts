import { describe, it, expect } from "vitest";
import { NextActionsService } from "../../src/services/next-actions.js";
import { ReviewService } from "../../src/services/review.js";
import { FakeMloRepository } from "../fakes/fake-mlo-repository.js";
import type { MloDocument } from "../../src/xml.js";
import type { TaskNode } from "../../src/types.js";
import { expectOk } from "../expect-result.js";

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

const NOW = new Date("2026-07-27T10:00:00"); // a Monday, 10:00 local
const now = () => NOW;

function repoWith(tasks: TaskNode[], places?: unknown): FakeMloRepository {
  const repo = new FakeMloRepository();
  repo.tasks = tasks;
  repo.doc = {
    "MyLifeOrganized-xml": {
      "@_ver": "1.2",
      TaskTree: { TaskNode: [] },
      ...(places ? { PlacesList: { TaskPlace: places } } : {}),
    },
  } as MloDocument;
  return repo;
}

describe("NextActionsService.nextActions", () => {
  it("returns the leaves the To-Do list would show, ranked", async () => {
    const overdue = task("1.1", "overdue", { DueDateTime: "2026-07-20T09:00:00" });
    const undated = task("1.2", "no date");
    const branch = task("1", "branch", { Children: [overdue, undated] });
    const service = new NextActionsService(repoWith([branch]), { now });

    const actions = expectOk(await service.nextActions());
    expect(actions.map((a) => a.task.id)).toEqual(["1.1", "1.2"]);
    expect(actions.every((a) => a.available)).toBe(true);
  });

  it("leaves deferred actions out by default and includes them with their reasons on request", async () => {
    const blocker = task("1", "blocker", { Guid: "{AAA}" });
    const blocked = task("2", "blocked", { DependsOn: ["{AAA}"] });
    const service = new NextActionsService(repoWith([blocker, blocked]), { now });

    expect(expectOk(await service.nextActions()).map((a) => a.task.id)).toEqual(["1"]);

    const all = expectOk(await service.nextActions({ availableOnly: false }));
    expect(all.map((a) => a.task.id)).toEqual(["1", "2"]);
    expect(all[1].blocks.map((b) => b.kind)).toEqual(["blocked-by-dependency"]);
  });

  it("filters by context, reaching the contexts the filter includes", async () => {
    const call = task("1", "call mum", { Places: ["Phone"] });
    const errand = task("2", "buy milk", { Places: ["@Town"] });
    const places = [{ "@_Caption": "@Home", Includes: { "@_Place": "Phone" } }, { "@_Caption": "Phone" }];
    const service = new NextActionsService(repoWith([call, errand], places), { now });

    expect(expectOk(await service.nextActions({ context: "@Home" })).map((a) => a.task.id)).toEqual(["1"]);
    expect(expectOk(await service.nextActions({ context: "Town" })).map((a) => a.task.id)).toEqual(["2"]);
  });

  it("fits actions into a clock-time budget, keeping the ones with no estimate", async () => {
    const quick = task("1", "quick", { EstimateMin: 10 / 1440 });
    const long = task("2", "long", { EstimateMin: 120 / 1440 });
    const unknown = task("3", "unestimated");
    const service = new NextActionsService(repoWith([quick, long, unknown]), { now });

    expect(expectOk(await service.nextActions({ maxTimeMin: 15 })).map((a) => a.task.id)).toEqual(["1", "3"]);
  });

  it("judges the budget on the pessimistic estimate when the profile has one", async () => {
    const maybeLong = task("1", "10 to 120 minutes", { EstimateMin: 10 / 1440, EstimateMax: 120 / 1440 });
    const service = new NextActionsService(repoWith([maybeLong]), { now });

    expect(expectOk(await service.nextActions({ maxTimeMin: 15 }))).toEqual([]);
    expect(expectOk(await service.nextActions({ maxTimeMin: 180 })).map((a) => a.task.id)).toEqual(["1"]);
  });

  it("caps effort on MLO's 0–200 scale, counting an unset Effort as normal", async () => {
    const easy = task("1", "easy", { Effort: 25 });
    const normal = task("2", "unset effort");
    const hard = task("3", "hard", { Effort: 175 });
    const service = new NextActionsService(repoWith([easy, normal, hard]), { now });

    expect(expectOk(await service.nextActions({ maxEffort: 100 })).map((a) => a.task.id)).toEqual(["1", "2"]);
  });

  it("truncates to the limit after ranking", async () => {
    const service = new NextActionsService(
      repoWith([task("1", "normal"), task("2", "critical", { Importance: 175 })]),
      { now }
    );
    expect(expectOk(await service.nextActions({ limit: 1 })).map((a) => a.task.id)).toEqual(["2"]);
  });
});

describe("ReviewService.inbox", () => {
  it("lists the open captures filed under the inbox node", async () => {
    const open = task("1.1", "an idea", { Path: ["<Inbox>", "an idea"] });
    const done = task("1.2", "filed", { CompletionDateTime: "2026-07-01T09:00:00" });
    const inbox = task("1", "<Inbox>", { Children: [open, done] });
    const service = new ReviewService(repoWith([inbox, task("2", "elsewhere")]));

    expect(expectOk(await service.inbox()).map((t) => t.id)).toEqual(["1.1"]);
  });

  it("honours the configured inbox caption and answers empty when there is no inbox", async () => {
    const captures = task("1", "Capture", { Children: [task("1.1", "an idea")] });
    expect(expectOk(await new ReviewService(repoWith([captures])).inbox())).toEqual([]);
    expect(
      expectOk(await new ReviewService(repoWith([captures]), { inboxCaption: "Capture" }).inbox()).map((t) => t.id)
    ).toEqual(["1.1"]);
  });
});

describe("ReviewService.projects", () => {
  /** A folder holding one project with an open and a completed leaf, plus a stalled project. */
  function outline(): TaskNode[] {
    const openLeaf = task("1.1.1", "write the outline");
    const doneLeaf = task("1.1.2", "book the room", { CompletionDateTime: "2026-07-01T09:00:00" });
    const project = task("1.1", "Run the workshop", {
      IsProject: true,
      ProjectStatus: 1,
      Children: [openLeaf, doneLeaf],
    });
    const folder = task("1", "Work", { HideInToDoThisTask: true, Children: [project] });
    const stalledLeaf = task("2.1", "waits forever", { StartDateTime: "2026-09-01T09:00:00" });
    const stalled = task("2", "Someday project", { IsProject: true, ProjectStatus: 2, Children: [stalledLeaf] });
    return [folder, stalled];
  }

  it("returns each project and folder with the open tasks nested under it", async () => {
    const branches = expectOk(await new ReviewService(repoWith(outline()), { now }).projects());

    expect(branches.map((b) => [b.task.id, b.kind])).toEqual([
      ["1", "folder"],
      ["1.1", "project"],
      ["2", "project"],
    ]);
    const workshop = branches[1];
    expect(workshop.tasks.map((t) => t.id)).toEqual(["1.1.1"]);
    expect(workshop.completed).toBe(1);
    expect(workshop.status).toBe(1);
  });

  it("counts the actions each branch can actually offer, so a stalled one reads zero", async () => {
    const branches = expectOk(await new ReviewService(repoWith(outline()), { now }).projects());
    expect(branches.find((b) => b.task.id === "1.1")?.availableActions).toBe(1);
    expect(branches.find((b) => b.task.id === "2")?.availableActions).toBe(0);
  });

  it("filters by kind and by MLO's manual project status", async () => {
    const service = new ReviewService(repoWith(outline()), { now });
    expect(expectOk(await service.projects({ kind: "folder" })).map((b) => b.task.id)).toEqual(["1"]);
    expect(expectOk(await service.projects({ status: 2 })).map((b) => b.task.id)).toEqual(["2"]);
  });

  it("skips completed branches unless asked for them", async () => {
    const done = task("1", "shipped", { IsProject: true, CompletionDateTime: "2026-07-01T09:00:00" });
    const service = new ReviewService(repoWith([done]), { now });
    expect(expectOk(await service.projects())).toEqual([]);
    expect(expectOk(await service.projects({ includeCompleted: true })).map((b) => b.task.id)).toEqual(["1"]);
  });
});

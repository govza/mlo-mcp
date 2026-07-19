import { describe, expect, it } from "vitest";
import { TODO_ITEMS_HEADER } from "../../src/cloud/delta.js";
import type { KnownRow } from "../../src/cloud/log-projection.js";
import { updatePatch, verifiesUpdate } from "../../src/tools/update-task.js";
import type { TaskNode } from "../../src/types.js";

function knownRow(values: Record<string, string>): KnownRow {
  const header = [...TODO_ITEMS_HEADER];
  return { header, row: header.map((column) => values[column] ?? "") };
}

describe("update_task patch mapping", () => {
  it("maps provided fields to columns and always stamps LastModified", () => {
    const patch = updatePatch({ id: "1", Caption: "new", Importance: 150, TheGoal: 2 }, knownRow({}), "T");
    expect(patch).toEqual({ LastModified: "T", Caption: "new", Importance: "150", GoalFor: "2" });
  });

  it("turns scheduling on with a first date and off when both dates clear", () => {
    expect(updatePatch({ id: "1", DueDateTime: "2026-08-01T15:00:00" }, knownRow({ ScheduleType: "0" }), "T").ScheduleType).toBe("1");
    expect(updatePatch({ id: "1", DueDateTime: "" }, knownRow({ ScheduleType: "1", StartDateTime: "" }), "T").ScheduleType).toBe("0");
    // an already-scheduled row keeps its (possibly richer) ScheduleType
    expect(updatePatch({ id: "1", DueDateTime: "2026-08-01T15:00:00" }, knownRow({ ScheduleType: "2" }), "T").ScheduleType).toBeUndefined();
  });

  it("re-parents through ParentUID, with empty string meaning top level", () => {
    expect(updatePatch({ id: "1" }, knownRow({}), "T", { parentUid: "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}", destCaption: "p" }).ParentUID)
      .toBe("{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}");
    expect(updatePatch({ id: "1" }, knownRow({}), "T", { parentUid: "" }).ParentUID).toBe("");
  });

  it("maps observed cloud booleans and flag assignment", () => {
    expect(updatePatch({
      id: "1", IsProject: true, Starred: true, Folder: true, HideInToDo: false,
      CompleteSubTasksInOrder: true, Flag: "Red Flag",
    }, knownRow({ Starred: "0" }), "T", undefined, { flagUid: "{F}" })).toMatchObject({
      IsProject: "1", Starred: "1", HideInToDoThisTask: "1", HideInToDo: "0",
      CompleteInOrder: "1", FlagUID: "{F}", StarToggleDateTime: "T",
    });
  });
});

describe("update_task verification", () => {
  const base: TaskNode = {
    id: "1", Caption: "c", Places: [], DependsOn: [], Children: [], Path: ["parent", "c"], Depth: 1,
  };

  it("checks the string fields it set", () => {
    expect(verifiesUpdate({ ...base, Caption: "new" }, { id: "1", Caption: "new" })).toBe(true);
    expect(verifiesUpdate(base, { id: "1", Caption: "new" })).toBe(false);
    expect(verifiesUpdate(base, { id: "1", Note: "" })).toBe(true);
    expect(verifiesUpdate({ ...base, DueDateTime: "X" }, { id: "1", DueDateTime: "Y" })).toBe(false);
  });

  it("checks the destination parent after a move", () => {
    expect(verifiesUpdate(base, { id: "1" }, { parentUid: "{A}", destCaption: "parent" })).toBe(true);
    expect(verifiesUpdate(base, { id: "1" }, { parentUid: "{A}", destCaption: "other" })).toBe(false);
    expect(verifiesUpdate({ ...base, Path: ["c"] }, { id: "1" }, { parentUid: "" })).toBe(true);
    expect(verifiesUpdate(base, { id: "1" }, { parentUid: "" })).toBe(false);
  });

  it("checks booleans, flag, and the complete context set", () => {
    const changed = { ...base, IsProject: true, Starred: true, HideInToDoThisTask: true, Flag: "Red Flag", Places: ["@Home"] };
    expect(verifiesUpdate(changed, {
      id: "1", IsProject: true, Starred: true, Folder: true, Flag: "red flag", Places: ["@home"],
    })).toBe(true);
    expect(verifiesUpdate(changed, { id: "1", Places: [] })).toBe(false);
  });

  it("checks the complete resolved dependency set", () => {
    const dependency = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
    expect(verifiesUpdate(
      { ...base, DependsOn: [dependency] },
      { id: "1", dependsOnIds: ["2"] },
      undefined,
      { dependencyUids: [dependency] },
    )).toBe(true);
    expect(verifiesUpdate(base, { id: "1", dependsOnIds: ["2"] }, undefined, { dependencyUids: [dependency] }))
      .toBe(false);
  });
});

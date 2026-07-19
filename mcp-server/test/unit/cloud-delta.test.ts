import { describe, expect, it } from "vitest";
import { buildTaskAddDelta, buildTaskDeleteDelta, buildTaskUpdatesDelta, createDeltaSkeleton, mergeDeltas, TODO_ITEMS_HEADER } from "../../src/cloud/delta.js";
import { findSection } from "../../src/cloud/csv.js";

const uid = "{12345678-1234-1234-1234-123456789abc}";

describe("cloud deltas", () => {
  it("builds an 82-column full add row with a parseable neutral ItemIndex", () => {
    const delta = buildTaskAddDelta({ uid, caption: "A", note: "N", createdDate: "2026-01-01T01:02:03", lastModified: "2026-01-01T01:02:03" });
    const section = findSection(delta, "TodoItems")!;
    expect(TODO_ITEMS_HEADER).toHaveLength(82);
    expect(section.header).toEqual(TODO_ITEMS_HEADER);
    expect(section.rows[0]).toHaveLength(82);
    expect(section.rows[0]![0]).toBe("{12345678-1234-1234-1234-123456789ABC}");
    expect(section.rows[0]![2]).toBe("100");
    expect(section.rows[0]![4]).toBe("100");
    expect(section.rows[0]![5]).toBe("100");
    expect(section.rows[0]![19]).toBe("50");
  });

  it("adds complete context and dependency relations for a new task", () => {
    const place = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
    const dependency = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
    const delta = buildTaskAddDelta({
      uid, caption: "related", createdDate: "a", lastModified: "a",
      placeUids: [place], dependencyUids: [dependency],
    });
    expect(findSection(delta, "TodoItemPlaces")!.rows).toEqual([[uid.toUpperCase(), place]]);
    expect(findSection(delta, "TodoItems.Dependency")!.rows).toEqual([[uid.toUpperCase(), dependency]]);
  });

  it("builds only TodoItems.Deleted tombstones, one row per uid", () => {
    const other = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
    const delta = buildTaskDeleteDelta([uid, other]);
    expect(findSection(delta, "TodoItems")!.rows).toEqual([]);
    expect(findSection(delta, "TodoItems.Deleted")!.rows).toEqual([
      ["{12345678-1234-1234-1234-123456789ABC}"],
      [other],
    ]);
  });

  it("uses newest full records and lets a tombstone remove a pending task", () => {
    const first = buildTaskAddDelta({ uid, caption: "old", createdDate: "a", lastModified: "a" });
    const second = buildTaskAddDelta({ uid, caption: "new", createdDate: "a", lastModified: "b" });
    const deleted = buildTaskDeleteDelta([uid]);
    expect(findSection(mergeDeltas([first, second]), "TodoItems")!.rows[0]![3]).toBe("new");
    const merged = mergeDeltas([first, second, deleted]);
    expect(findSection(merged, "TodoItems")!.rows).toEqual([]);
    expect(findSection(merged, "TodoItems.Deleted")!.rows).toHaveLength(1);
  });

  it("emits complete task relations and starred ordering on authored rows", () => {
    const place = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
    const dependency = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
    const row = TODO_ITEMS_HEADER.map((column) => column === "UID" ? uid : "");
    const delta = buildTaskUpdatesDelta([{
      header: TODO_ITEMS_HEADER,
      row,
      patch: { Starred: "1" },
      placeUids: [place],
      dependencyUids: [dependency],
      starredOrderIndex: "500",
    }]);
    expect(findSection(delta, "TodoItemPlaces")!.rows).toEqual([[uid.toUpperCase(), place]]);
    expect(findSection(delta, "TodoItems.Dependency")!.rows).toEqual([[uid.toUpperCase(), dependency]]);
    expect(findSection(delta, "TodoView.ManualOrdering.Starred")!.rows).toEqual([[uid.toUpperCase(), "500"]]);
  });

  it("treats relations for an emitted task as a complete replacement set", () => {
    const place = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
    const first = buildTaskAddDelta({
      uid, caption: "contextual", createdDate: "a", lastModified: "a", placeUids: [place],
    });
    const known = findSection(first, "TodoItems")!;
    const cleared = buildTaskUpdatesDelta([{
      header: known.header, row: known.rows[0]!, patch: { LastModified: "b" }, placeUids: [], dependencyUids: [],
    }]);
    expect(findSection(mergeDeltas([first, cleared]), "TodoItemPlaces")!.rows).toEqual([]);
  });

  it("removes deleted Place and Flag definitions from the merged lookup state", () => {
    const place = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
    const flag = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
    const first = createDeltaSkeleton();
    findSection(first, "Places")!.rows.push([place, "@Home"]);
    findSection(first, "Flags")!.rows.push([flag, "Red Flag"]);
    const deleted = createDeltaSkeleton();
    findSection(deleted, "Places.Deleted")!.rows.push([place]);
    findSection(deleted, "Flags.Deleted")!.rows.push([flag]);
    const merged = mergeDeltas([first, deleted]);
    expect(findSection(merged, "Places")!.rows).toEqual([]);
    expect(findSection(merged, "Flags")!.rows).toEqual([]);
  });

  it("always has the complete 11-section skeleton", () => {
    expect(createDeltaSkeleton().sections).toHaveLength(11);
  });
});

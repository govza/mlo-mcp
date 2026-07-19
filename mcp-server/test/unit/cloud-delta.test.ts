import { describe, expect, it } from "vitest";
import { buildTaskAddDelta, buildTaskDeleteDelta, createDeltaSkeleton, mergeDeltas, TODO_ITEMS_HEADER } from "../../src/cloud/delta.js";
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

  it("always has the complete 11-section skeleton", () => {
    expect(createDeltaSkeleton().sections).toHaveLength(11);
  });
});

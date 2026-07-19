import { describe, expect, it } from "vitest";
import type { TaskNode } from "../../src/types.js";
import { collectTombstones, wereTasksDeleted } from "../../src/tools/cloud-delete-task.js";

function task(id: string, caption: string, guid?: string, children: TaskNode[] = []): TaskNode {
  return {
    id,
    Guid: guid,
    Caption: caption,
    Places: [],
    DependsOn: [],
    Children: children,
    Path: [caption],
    Depth: 0,
  };
}

const A = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const B = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
const C = "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}";

describe("cloud_delete_task tombstone collection", () => {
  it("tombstones every descendant, not just the selected task", () => {
    const tree = [task("1", "parent", A, [task("1.1", "child", B, [task("1.1.1", "grandchild", C)])])];
    const { uids, missingGuid } = collectTombstones(tree, ["1"]);
    expect(uids.sort()).toEqual([A, B, C].sort());
    expect(missingGuid).toEqual([]);
  });

  it("dedupes an id nested under another selected id", () => {
    const child = task("1.1", "child", B);
    const tree = [task("1", "parent", A, [child])];
    const { uids } = collectTombstones(tree, ["1", "1.1"]);
    expect(uids.sort()).toEqual([A, B].sort());
  });

  it("reports every subtree member lacking a recoverable GUID", () => {
    const tree = [task("1", "parent", A, [task("1.1", "no-guid-child")])];
    const { missingGuid } = collectTombstones(tree, ["1"]);
    expect(missingGuid.map((t) => t.id)).toEqual(["1.1"]);
  });

  it("throws on an unknown id", () => {
    expect(() => collectTombstones([task("1", "only", A)], ["2"])).toThrow(/re-run list_tasks/);
  });
});

describe("cloud_delete_task verification", () => {
  it("is not verified while a tombstoned GUID is still exported", () => {
    expect(wereTasksDeleted([task("1", "survivor", A)], [A])).toBe(false);
  });

  it("is verified once no tombstoned GUID remains, regardless of other tasks", () => {
    expect(wereTasksDeleted([task("1", "unrelated", B)], [A])).toBe(true);
  });

  it("compares GUIDs case-insensitively", () => {
    expect(wereTasksDeleted([task("1", "survivor", A.toLowerCase())], [A])).toBe(false);
  });
});

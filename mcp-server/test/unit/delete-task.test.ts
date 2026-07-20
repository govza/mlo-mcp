import { describe, expect, it } from "vitest";
import type { TaskNode } from "../../src/types.js";
import { collectTombstones, wereTasksDeleted } from "../../src/tools/delete-task.js";

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

describe("delete_task tombstone collection", () => {
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

describe("delete_task verification", () => {
  it("is not verified while a tombstoned GUID is still exported", () => {
    const survivor = task("1", "survivor", A);
    expect(wereTasksDeleted([survivor], [survivor], [A])).toBe(false);
  });

  it("is verified once no tombstoned GUID remains, regardless of other tasks", () => {
    const before = [task("1", "doomed", A), task("2", "unrelated", B)];
    expect(wereTasksDeleted(before, [task("1", "unrelated", B)], [A])).toBe(true);
  });

  it("compares GUIDs case-insensitively", () => {
    const survivor = task("1", "survivor", A.toLowerCase());
    expect(wereTasksDeleted([survivor], [survivor], [A])).toBe(false);
  });

  // A task added through the cloud log has no binary footer, so the export
  // carries no Guid for it. Matching on Guid alone found nothing and read that
  // as "deleted" — reporting success for a delta MLO had not applied yet.
  it("does not read a GUID-less survivor as deleted", () => {
    const survivor = task("1", "queued but unapplied");
    expect(wereTasksDeleted([survivor], [survivor], [A])).toBe(false);
  });

  it("resolves identity the same way the tombstones were targeted", () => {
    const survivor = task("1", "cloud-only");
    const viaCloudLog = (t: TaskNode) => (t.Caption === "cloud-only" ? A : undefined);
    expect(wereTasksDeleted([survivor], [survivor], [A], viaCloudLog)).toBe(false);
  });

  it("requires the tree to shrink by the tombstoned subtree size", () => {
    const before = [task("1", "parent", A, [task("1.1", "child", B)])];
    expect(wereTasksDeleted(before, [], [A, B])).toBe(true);
    // same uids claimed gone, but only one node actually left the tree
    expect(wereTasksDeleted(before, [task("1", "leftover", C)], [A, B])).toBe(false);
  });
});

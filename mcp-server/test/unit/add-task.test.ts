import { describe, expect, it } from "vitest";
import type { TaskNode } from "../../src/types.js";
import { wasTaskAdded } from "../../src/tools/add-task.js";

function task(caption: string, guid: string, note?: string): TaskNode {
  return {
    id: guid,
    Guid: guid,
    Caption: caption,
    Note: note,
    Places: [],
    DependsOn: [],
    Children: [],
    Path: [caption],
    Depth: 0,
  };
}

describe("add_task verification", () => {
  it("does not treat a pre-existing duplicate caption as a successful add", () => {
    const existing = task("duplicate", "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}");
    expect(wasTaskAdded([existing], [existing], "duplicate", undefined, "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}"))
      .toBe(false);
  });

  it("accepts a newly added matching task even when its recovered GUID differs", () => {
    const existing = task("duplicate", "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}");
    const added = task("duplicate", "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}");
    expect(wasTaskAdded([existing], [existing, added], "duplicate", undefined, "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}"))
      .toBe(true);
  });

  it("uses the note to distinguish otherwise identical tasks", () => {
    const existing = task("duplicate", "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}", "old");
    const added = task("duplicate", "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}", "new");
    expect(wasTaskAdded([existing], [existing, added], "duplicate", "new", "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}"))
      .toBe(true);
  });
});

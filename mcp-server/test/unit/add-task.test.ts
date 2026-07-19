import { describe, expect, it } from "vitest";
import type { TaskNode } from "../../src/types.js";
import { wasOutlineAdded } from "../../src/tools/add-tasks.js";

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

const QUEUED = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";

describe("add verification (shared by add_task and add_tasks)", () => {
  it("does not treat a pre-existing duplicate caption as a successful add", () => {
    const existing = task("duplicate", "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}");
    expect(wasOutlineAdded([existing], [existing], [{ caption: "duplicate" }], [QUEUED])).toBe(false);
  });

  it("accepts a newly added matching task even when its recovered GUID differs", () => {
    const existing = task("duplicate", "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}");
    const added = task("duplicate", "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}");
    expect(wasOutlineAdded([existing], [existing, added], [{ caption: "duplicate" }], [QUEUED])).toBe(true);
  });

  it("uses the note to distinguish otherwise identical tasks", () => {
    const existing = task("duplicate", "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}", "old");
    const added = task("duplicate", "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}", "new");
    expect(wasOutlineAdded([existing], [existing, added], [{ caption: "duplicate", note: "new" }], [QUEUED])).toBe(true);
  });

  it("is verified directly by the queued GUID appearing in the export", () => {
    const added = task("solo", QUEUED);
    expect(wasOutlineAdded([], [added], [{ caption: "solo" }], [QUEUED])).toBe(true);
  });

  it("requires every requested duplicate to appear, not just one", () => {
    const existing = task("twin", "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}");
    const added = task("twin", "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}");
    const specs = [{ caption: "twin" }, { caption: "twin" }];
    const queued = [QUEUED, "{DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD}"];
    expect(wasOutlineAdded([existing], [existing, added], specs, queued)).toBe(false);
    expect(wasOutlineAdded([existing], [existing, added, task("twin", "{EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE}")], specs, queued)).toBe(true);
  });

  it("is unverified without a pre-sync export when GUID recovery fails", () => {
    const added = task("solo", "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}");
    expect(wasOutlineAdded(undefined, [added], [{ caption: "solo" }], [QUEUED])).toBe(false);
  });
});

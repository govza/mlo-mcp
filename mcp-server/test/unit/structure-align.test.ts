import { describe, expect, it } from "vitest";
import { alignExportToSnapshot, buildUidResolver } from "../../src/cloud/structure-align.js";
import type { KnownCloudProjection, KnownRow } from "../../src/cloud/log-projection.js";
import type { TaskNode } from "../../src/types.js";

const HEADER = ["UID", "ParentUID", "ItemIndex", "Caption"];

function projectionOf(rows: [uid: string, parent: string, itemIndex: string, caption: string][]): KnownCloudProjection {
  const map = new Map<string, KnownRow>();
  for (const row of rows) map.set(row[0], { header: HEADER, row: [...row] });
  return {
    rows: map,
    placeUidsByTask: new Map(),
    dependencyUidsByTask: new Map(),
    places: [],
    flags: [],
    starredOrderByTask: new Map(),
  };
}

let nextId = 0;
function task(caption: string, children: TaskNode[] = [], guid?: string): TaskNode {
  return {
    id: String(++nextId),
    Caption: caption,
    Guid: guid,
    Places: [],
    DependsOn: [],
    Children: children,
    Path: [caption],
    Depth: 1,
  };
}

const A = "{AAAAAAAA-0000-0000-0000-000000000001}";
const B = "{AAAAAAAA-0000-0000-0000-000000000002}";
const C = "{AAAAAAAA-0000-0000-0000-000000000003}";

describe("structural alignment", () => {
  it("resolves duplicate sibling captions by position", () => {
    // Two siblings with the SAME caption — the caption-path walk gives up
    // here; position within the ItemIndex-ordered slot does not.
    const projection = projectionOf([
      [A, "", "25", "Buy milk"],
      [B, "", "50", "Buy milk"],
    ]);
    const first = task("Buy milk");
    const second = task("Buy milk");
    const identity = alignExportToSnapshot([first, second], projection);
    expect(identity.byPathId.get(first.id)).toBe(A);
    expect(identity.byPathId.get(second.id)).toBe(B);
    expect(identity.confidence.get(first.id)).toBe("positional");
  });

  it("orders siblings by numeric ItemIndex, not row order", () => {
    const projection = projectionOf([
      [B, "", "200", "Second"],
      [A, "", "25", "First"], // appears later but sorts first
    ]);
    const first = task("First");
    const second = task("Second");
    const identity = alignExportToSnapshot([first, second], projection);
    expect(identity.byPathId.get(first.id)).toBe(A);
    expect(identity.byPathId.get(second.id)).toBe(B);
  });

  it("aligns nested children through ParentUID", () => {
    const projection = projectionOf([
      [A, "", "25", "Project"],
      [B, A, "25", "Step"],
      [C, A, "50", "Step"], // duplicate captions among children
    ]);
    const stepOne = task("Step");
    const stepTwo = task("Step");
    const project = task("Project", [stepOne, stepTwo]);
    const identity = alignExportToSnapshot([project], projection);
    expect(identity.byPathId.get(project.id)).toBe(A);
    expect(identity.byPathId.get(stepOne.id)).toBe(B);
    expect(identity.byPathId.get(stepTwo.id)).toBe(C);
  });

  it("falls back to unique-caption pairing when sibling counts drift, leaving duplicates unresolved", () => {
    const projection = projectionOf([
      [A, "", "25", "Unique task"],
      [B, "", "50", "Twin"],
      [C, "", "75", "Twin"],
    ]);
    // The export has one extra task the cloud has not seen (drift).
    const unique = task("Unique task");
    const twinOne = task("Twin");
    const twinTwo = task("Twin");
    const fresh = task("Just captured");
    const identity = alignExportToSnapshot([unique, twinOne, fresh, twinTwo], projection);
    expect(identity.byPathId.get(unique.id)).toBe(A);
    expect(identity.confidence.get(unique.id)).toBe("caption-unique");
    // Twins are ambiguous under drift: fail closed.
    expect(identity.byPathId.has(twinOne.id)).toBe(false);
    expect(identity.byPathId.has(twinTwo.id)).toBe(false);
    expect(identity.byPathId.has(fresh.id)).toBe(false);
  });

  it("vetoes positional pairing when captions disagree", () => {
    const projection = projectionOf([
      [A, "", "25", "Alpha"],
      [B, "", "50", "Beta"],
    ]);
    // Same count, but the export order contradicts the captions — position
    // alone must not win.
    const beta = task("Beta");
    const gamma = task("Gamma");
    const identity = alignExportToSnapshot([beta, gamma], projection);
    expect(identity.byPathId.get(beta.id)).toBe(B); // caption-unique fallback
    expect(identity.byPathId.has(gamma.id)).toBe(false);
  });

  it("prefers the structural result over a contradicting binary GUID", () => {
    const projection = projectionOf([
      [A, "", "25", "Task"],
    ]);
    const node = task("Task", [], B); // stale binary recovery
    const resolve = buildUidResolver([node], projection);
    expect(resolve(node)).toBe(A);
  });

  it("uses the binary GUID only for nodes the alignment could not place", () => {
    const projection = projectionOf([
      [A, "", "25", "Twin"],
      [B, "", "50", "Twin"],
      [C, "", "75", "Other"],
    ]);
    const twin = task("Twin", [], B);
    const identity = alignExportToSnapshot([twin], projection); // count drift + duplicate caption
    expect(identity.byPathId.has(twin.id)).toBe(false);
    const resolve = buildUidResolver([twin], projection);
    expect(resolve(twin)).toBe(B); // falls back to the recovered GUID
  });
});

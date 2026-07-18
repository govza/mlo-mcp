import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseMloXml } from "../../src/xml.js";
import { buildTaskTree, findInbox, findRawInbox, looksLikeInbox, renderLine } from "../../src/task-tree.js";
import type { TaskNode } from "../../src/types.js";

const FIXTURE = path.join(__dirname, "..", "fixtures", "export.xml");
const doc = parseMloXml(readFileSync(FIXTURE, "utf8"));
const tree = buildTaskTree(doc);

function top(caption: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "1",
    Caption: caption,
    Places: [],
    DependsOn: [],
    Children: [],
    Path: [caption],
    Depth: 0,
    ...extra,
  } as TaskNode;
}

describe("findInbox", () => {
  it("finds MLO's canonical <Inbox> node in the fixture profile", () => {
    const inbox = findInbox(tree);
    expect(inbox).toBeDefined();
    expect(inbox!.Caption).toBe("<Inbox>");
    expect(inbox!.Depth).toBe(0);
  });

  it("falls back to a plain Inbox caption", () => {
    expect(findInbox([top("Inbox")])?.Caption).toBe("Inbox");
  });

  it("prefers <Inbox> over a plain Inbox", () => {
    const tasks = [top("Inbox"), top("<Inbox>")];
    expect(findInbox(tasks)?.Caption).toBe("<Inbox>");
  });

  it("prefers the configured caption over both", () => {
    const tasks = [top("<Inbox>"), top("Входящие")];
    expect(findInbox(tasks, "Входящие")?.Caption).toBe("Входящие");
  });

  it("ignores a nested task that happens to be captioned Inbox", () => {
    const nested = top("Inbox", { id: "1.1", Depth: 1, Path: ["Area", "Inbox"] });
    const area = top("Area", { Children: [nested] });
    // findInbox scans only the top-level list it is given
    expect(findInbox([area])).toBeUndefined();
  });

  it("returns undefined when no inbox exists", () => {
    expect(findInbox([top("Business")])).toBeUndefined();
  });
});

describe("findRawInbox", () => {
  it("locates the raw <Inbox> node for mutation", () => {
    const raw = findRawInbox(doc);
    expect(raw).toBeDefined();
    expect(raw!["@_Caption"]).toBe("<Inbox>");
  });
});

describe("inbox rendering", () => {
  it("marks the top-level inbox in outline lines", () => {
    const inbox = findInbox(tree)!;
    expect(looksLikeInbox(inbox)).toBe(true);
    expect(renderLine(inbox)).toContain("[inbox]");
  });

  it("does not mark non-inbox or nested tasks", () => {
    expect(looksLikeInbox(top("Business"))).toBe(false);
    expect(looksLikeInbox(top("<Inbox>", { Depth: 1 }))).toBe(false);
  });
});

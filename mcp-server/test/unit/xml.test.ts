import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseMloXml, rootNode } from "../../src/xml.js";
import { buildTaskTree, flatten, findById, searchTasks } from "../../src/task-tree.js";

const FIXTURE = path.join(__dirname, "..", "fixtures", "export.xml");
const xml = readFileSync(FIXTURE, "utf8");

describe("parseMloXml", () => {
  const doc = parseMloXml(xml);

  it("finds the root TaskNode with empty caption", () => {
    expect(rootNode(doc)["@_Caption"]).toBe("");
    expect(rootNode(doc).TaskNode!.length).toBeGreaterThan(3);
  });

  it("keeps single-child nodes as arrays", () => {
    const tree = buildTaskTree(doc);
    const withOneChild = flatten(tree).find((t) => t.Children.length === 1);
    expect(withOneChild).toBeDefined();
  });

  it("finds a demo task with due date and context", () => {
    const tree = buildTaskTree(doc);
    const t = flatten(tree).find((x) => x.Caption === "Finish the presentation");
    expect(t).toBeDefined();
    expect(t!.DueDateTime).toBe("2010-08-10T00:00:00");
    expect(t!.Places).toContain("@Office");
  });

  it("decodes entities in captions", () => {
    const tree = buildTaskTree(doc);
    expect(flatten(tree).some((t) => t.Caption === 'Read "Prep for PMI" book')).toBe(true);
  });

  it("preserves multiline notes", () => {
    const tree = buildTaskTree(doc);
    const noted = flatten(tree).filter((t) => t.Note?.includes("\n"));
    expect(noted.length).toBeGreaterThan(0);
  });

  it("maps Delphi -1 booleans", () => {
    const tree = buildTaskTree(doc);
    const project = flatten(tree).find((t) => t.IsProject);
    expect(project).toBeDefined();
  });
});

describe("task-tree ids and lookup", () => {
  const tree = buildTaskTree(parseMloXml(xml));

  it("assigns deterministic path ids", () => {
    expect(tree[0].id).toBe("1");
    if (tree[0].Children.length) expect(tree[0].Children[0].id).toBe("1.1");
  });

  it("findById returns the same node as flatten", () => {
    const some = flatten(tree)[10];
    expect(findById(tree, some.id)).toBe(some);
  });
});

describe("searchTasks", () => {
  const tree = buildTaskTree(parseMloXml(xml));

  it("filters by context (with or without @)", () => {
    const a = searchTasks(tree, { context: "@Office" });
    const b = searchTasks(tree, { context: "office" });
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
  });

  it("filters by completion", () => {
    const done = searchTasks(tree, { completed: true });
    const open = searchTasks(tree, { completed: false });
    expect(done.length + open.length).toBe(flatten(tree).length);
  });

  it("text query hits notes too", () => {
    const hits = searchTasks(tree, { query: "pmi.org" });
    expect(hits.length).toBeGreaterThan(0);
  });
});

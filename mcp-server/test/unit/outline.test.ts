import { describe, it, expect } from "vitest";
import { parseOutline } from "../../src/tools/add-task.js";

describe("parseOutline", () => {
  it("builds nested structure from 2-space indentation", () => {
    const nodes = parseOutline("Warm-up\nMain set\n  Intervals\n  Cooldown swim\nStretching");
    expect(nodes.map((n) => n["@_Caption"])).toEqual(["Warm-up", "Main set", "Stretching"]);
    expect(nodes[1].TaskNode!.map((n) => n["@_Caption"])).toEqual(["Intervals", "Cooldown swim"]);
  });

  it("supports tabs and arbitrary depth", () => {
    const nodes = parseOutline("a\n\tb\n\t\tc\n\t\t\td");
    expect(nodes[0].TaskNode![0].TaskNode![0].TaskNode![0]["@_Caption"]).toBe("d");
  });

  it("ignores blank lines and recovers from dedent", () => {
    const nodes = parseOutline("a\n  b\n\n  c\nd\n  e");
    expect(nodes.map((n) => n["@_Caption"])).toEqual(["a", "d"]);
    expect(nodes[0].TaskNode!.map((n) => n["@_Caption"])).toEqual(["b", "c"]);
    expect(nodes[1].TaskNode![0]["@_Caption"]).toBe("e");
  });
});

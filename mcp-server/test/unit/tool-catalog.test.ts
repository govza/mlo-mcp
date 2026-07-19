import { describe, it, expect } from "vitest";
import { catalog, renderDetail, renderList, toolInfo } from "../../scripts/tool-catalog.js";
import { allTools } from "../../src/tools/registry.js";
import { addTaskTool } from "../../src/tools/add-task.js";
import { getTaskTool } from "../../src/tools/get-task.js";
import { deleteTaskTool } from "../../src/tools/delete-task.js";
import { updateTaskTool } from "../../src/tools/update-task.js";

describe("tool catalog", () => {
  it("covers every registered tool", () => {
    expect(catalog().map((t) => t.name)).toEqual(allTools.map((t) => t.name));
  });

  it("derives kind from the annotations", () => {
    expect(toolInfo(getTaskTool).kind).toBe("read");
    expect(toolInfo(addTaskTool).kind).toBe("write");
    expect(toolInfo(deleteTaskTool).kind).toBe("destructive");
  });

  it("reads types, requiredness and descriptions off the zod schemas", () => {
    const input = toolInfo(addTaskTool).input;
    expect(input.find((f) => f.name === "caption")!.required).toBe(true);
    expect(input.find((f) => f.name === "dueDateTime")!.required).toBe(false);
    expect(toolInfo(deleteTaskTool).input.find((f) => f.name === "ids")!.description).toContain("Path-based");
    expect(toolInfo(getTaskTool).input.find((f) => f.name === "id")!.required).toBe(true);
  });

  it("expands one level of object/array params so batch entries are visible", () => {
    const updates = toolInfo(updateTaskTool, true).input.find((f) => f.name === "updates")!;
    expect(updates.type).toBe("object[] (1-25)");
    expect(updates.fields?.map((f) => f.name)).toContain("Caption");
    expect(updates.fields?.find((f) => f.name === "id")!.required).toBe(true);
  });

  it("lists every tool name under a kind heading", () => {
    const list = renderList();
    for (const tool of allTools) expect(list).toContain(tool.name);
    expect(list).toContain("DESTRUCTIVE");
  });

  it("renders detail for each tool and refuses unknown names", () => {
    for (const tool of allTools) expect(renderDetail(tool.name)).toContain(tool.title);
    expect(renderDetail("nope")).toBeUndefined();
  });
});

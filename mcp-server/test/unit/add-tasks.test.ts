import { describe, expect, it } from "vitest";
import { addTasksTool } from "../../src/tools/add-tasks.js";

describe("add_tasks validation", () => {
  it("rejects duplicate keys before touching external state", async () => {
    await expect(addTasksTool.execute({ tasks: [
      { key: "a", caption: "one" },
      { key: "a", caption: "two" },
    ] }, {} as never)).rejects.toThrow(/duplicate task key/);
  });

  it("rejects parent cycles before touching external state", async () => {
    await expect(addTasksTool.execute({ tasks: [
      { key: "a", caption: "one", parentKey: "b" },
      { key: "b", caption: "two", parentKey: "a" },
    ] }, {} as never)).rejects.toThrow(/parentKey cycle/);
  });
});

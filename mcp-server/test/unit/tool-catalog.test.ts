import { describe, it, expect } from "vitest";
import { catalog, renderDetail, renderList, toolInfo, type FieldInfo } from "../../scripts/tool-catalog.js";
import { allTools } from "../../src/tools/registry.js";
import { PATH_ID_CAVEAT } from "../../src/tools/shared.js";
import { addTaskTool } from "../../src/tools/add-task.js";
import { getTaskTool } from "../../src/tools/get-task.js";
import { deleteTaskTool } from "../../src/tools/delete-task.js";
import { updateTaskTool } from "../../src/tools/update-task.js";

type ReferenceKind = "guid" | "path";

/**
 * Task references classified by field name, one level of batch nesting
 * included: `…Uid`/`…Uids` carry a task's stable identity, `…Id`/`…Ids` carry
 * its positional Path id. Batch-local `…Key` names are neither — they only
 * mean something inside the one call that declares them.
 */
function referenceFields(
  fields: FieldInfo[],
  prefix = ""
): Array<{ path: string; kind: ReferenceKind; description?: string }> {
  const found: Array<{ path: string; kind: ReferenceKind; description?: string }> = [];
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const kind: ReferenceKind | undefined = /uids?$/i.test(field.name)
      ? "guid"
      : /ids?$/i.test(field.name)
        ? "path"
        : undefined;
    if (kind) found.push({ path, kind, description: field.description });
    if (field.fields) found.push(...referenceFields(field.fields, path));
  }
  return found;
}

/** Free-form text fields, one level of batch nesting included. */
function noteFields(fields: FieldInfo[], prefix = ""): Array<{ path: string; description?: string }> {
  const found: Array<{ path: string; description?: string }> = [];
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    if (/^note$/i.test(field.name)) found.push({ path, description: field.description });
    if (field.fields) found.push(...noteFields(field.fields, path));
  }
  return found;
}

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

  it("documents every task reference in the schema itself", () => {
    // A client that only reads schemas — a tool-picker UI, a smaller model, a
    // harness that never surfaces `instructions` — must still learn which kind
    // of reference a field takes. Asserted over the whole registry so a new
    // tool with an undocumented reference fails here rather than shipping.
    for (const tool of allTools) {
      for (const field of referenceFields(toolInfo(tool, true).input)) {
        const label = `${tool.name}.${field.path}`;
        expect(field.description, `${label} has no description`).toBeTruthy();
        if (field.kind === "guid") {
          expect(field.description, `${label} must name GUID`).toMatch(/GUID/);
          expect(field.description, `${label} must point at get_task`).toMatch(/get_task/);
        } else {
          // Either the glossary's noun ("Path id", CONTEXT.md) or the
          // adjectival form the schemas already use — the rule is that the
          // positional nature is named, not which wording names it.
          expect(field.description, `${label} must name its Path id nature`).toMatch(/Path[- ]based|Path ids?\b/i);
          expect(field.description, `${label} must carry PATH_ID_CAVEAT`).toContain(PATH_ID_CAVEAT);
        }
      }
    }
  });

  it("says what the free-form note field carries", () => {
    // The one field that can hold *why a task exists* was the only task field
    // the schema said nothing about, so a client reading schemas alone had no
    // reason to use it. Asserted as a class, like the reference fields above.
    const seen: string[] = [];
    for (const tool of allTools) {
      for (const field of noteFields(toolInfo(tool, true).input)) {
        const label = `${tool.name}.${field.path}`;
        seen.push(label);
        expect(field.description, `${label} has no description`).toBeTruthy();
      }
    }
    expect(seen).toContain("add_task.note");
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

import { describe, it, expect } from "vitest";
import { catalog, renderDetail, renderList, toolInfo, type FieldInfo } from "../../scripts/tool-catalog.js";
import { allTools } from "../../src/tools/registry.js";
import { PATH_ID_CAVEAT } from "../../src/tools/shared.js";
import { getTaskTool } from "../../src/tools/get-task.js";
import { syncTool } from "../../src/tools/sync.js";

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

describe("tool catalog", () => {
  it("covers every registered tool", () => {
    expect(catalog().map((t) => t.name)).toEqual(allTools.map((t) => t.name));
  });

  it("derives kind from the annotations", () => {
    expect(toolInfo(getTaskTool).kind).toBe("read");
    expect(toolInfo(syncTool).kind).toBe("write");
  });

  it("reads types, requiredness and descriptions off the zod schemas", () => {
    const input = toolInfo(getTaskTool).input;
    expect(input.find((f) => f.name === "id")!.required).toBe(true);
    expect(input.find((f) => f.name === "id")!.description).toContain("Path-based");
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

  it("lists every tool name under a kind heading", () => {
    const list = renderList();
    for (const tool of allTools) expect(list).toContain(tool.name);
    expect(list).toContain("READ");
  });

  it("renders detail for each tool and refuses unknown names", () => {
    for (const tool of allTools) expect(renderDetail(tool.name)).toContain(tool.title);
    expect(renderDetail("nope")).toBeUndefined();
  });
});

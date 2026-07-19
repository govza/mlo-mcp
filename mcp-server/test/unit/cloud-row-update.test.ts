import { describe, expect, it } from "vitest";
import { buildTaskAddDelta, buildTaskDeleteDelta, buildTaskUpdatesDelta, TODO_ITEMS_HEADER } from "../../src/cloud/delta.js";
import { findSection } from "../../src/cloud/csv.js";
import { latestFullRows, rowValue, type KnownRow } from "../../src/cloud/log-projection.js";
import { completionPatch, guardNotRecurring } from "../../src/tools/cloud-complete-task.js";
import { reopenPatch } from "../../src/tools/cloud-uncomplete-task.js";
import type { TaskNode } from "../../src/types.js";

const uid = "{12345678-1234-1234-1234-123456789ABC}";

function knownRow(values: Record<string, string>): KnownRow {
  const header = [...TODO_ITEMS_HEADER];
  const row = header.map((column) => values[column] ?? "");
  return { header, row };
}

describe("latestFullRows", () => {
  it("keeps the newest full row per UID, keyed uppercase", () => {
    const first = buildTaskAddDelta({ uid: uid.toLowerCase(), caption: "old", createdDate: "a", lastModified: "a" });
    const second = buildTaskAddDelta({ uid, caption: "new", createdDate: "a", lastModified: "b" });
    const rows = latestFullRows([first, second]);
    expect(rows.size).toBe(1);
    expect(rowValue(rows.get(uid)!, "Caption")).toBe("new");
  });

  it("drops a UID once tombstoned", () => {
    const add = buildTaskAddDelta({ uid, caption: "gone", createdDate: "a", lastModified: "a" });
    expect(latestFullRows([add, buildTaskDeleteDelta([uid])]).has(uid)).toBe(false);
  });
});

describe("buildTaskUpdatesDelta", () => {
  it("emits the source row with only the patched columns changed", () => {
    const known = knownRow({ UID: uid, Caption: "keep", Reminder: "2026-01-01T09:00:00", RecType: "0" });
    const delta = buildTaskUpdatesDelta([{ header: known.header, row: known.row, patch: { CompletionDateTime: "X" } }]);
    const section = findSection(delta, "TodoItems")!;
    const get = (column: string) => section.rows[0]![section.header.indexOf(column)];
    expect(section.rows).toHaveLength(1);
    expect(get("Caption")).toBe("keep");
    expect(get("Reminder")).toBe("2026-01-01T09:00:00");
    expect(get("CompletionDateTime")).toBe("X");
  });

  it("preserves unknown source columns and rejects unknown patch columns", () => {
    const known: KnownRow = { header: [...TODO_ITEMS_HEADER, "FutureColumn"], row: [...knownRow({ UID: uid }).row, "kept"] };
    const delta = buildTaskUpdatesDelta([{ header: known.header, row: known.row, patch: {} }]);
    const section = findSection(delta, "TodoItems")!;
    expect(section.rows[0]![section.header.indexOf("FutureColumn")]).toBe("kept");
    expect(() => buildTaskUpdatesDelta([{ header: known.header, row: known.row, patch: { Nope: "x" } }])).toThrow(/unknown TodoItems column/);
  });
});

describe("completion and reopen patches", () => {
  it("stamps completion and flips a project to completed status", () => {
    expect(completionPatch(knownRow({ IsProject: "0" }), "T")).toEqual({ CompletionDateTime: "T", LastModified: "T" });
    expect(completionPatch(knownRow({ IsProject: "1" }), "T").ProjectStatus).toBe("3");
    expect(completionPatch(knownRow({ IsProject: "-1" }), "T").ProjectStatus).toBe("3");
  });

  it("clears completion and reactivates only a completed project", () => {
    expect(reopenPatch(knownRow({ ProjectStatus: "3" }), "T")).toEqual({ CompletionDateTime: "", LastModified: "T", ProjectStatus: "0" });
    expect(reopenPatch(knownRow({ ProjectStatus: "0" }), "T")).toEqual({ CompletionDateTime: "", LastModified: "T" });
  });

  it("refuses to complete a recurring task", () => {
    const task = { id: "1", Caption: "weekly", Places: [], DependsOn: [], Children: [], Path: ["weekly"], Depth: 0 } as TaskNode;
    const target = { id: "1", task, uid, known: knownRow({ RecType: "1" }) };
    expect(() => guardNotRecurring(target)).toThrow(/recurrence/);
    expect(() => guardNotRecurring({ ...target, known: knownRow({ RecType: "0" }) })).not.toThrow();
    expect(() => guardNotRecurring({ ...target, known: knownRow({}) })).not.toThrow();
  });
});

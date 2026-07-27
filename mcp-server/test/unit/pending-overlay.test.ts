import { describe, expect, it } from "vitest";
import { overlayPendingWrites, type PendingRows } from "../../src/repo/pending-overlay.js";
import { TODO_ITEMS_HEADER, normalizeGuid } from "../../src/cloud/delta.js";
import { flatten } from "../../src/task-tree.js";
import type { TaskNode } from "../../src/types.js";

/**
 * The read-your-own-writes overlay (spec section 2) against hand-authored
 * rows: all four verbs, and the silence an entry leaves when its write drops
 * out of the queue.
 */

const UID_A = "{AAAAAAAA-0000-0000-0000-000000000001}";
const UID_B = "{BBBBBBBB-0000-0000-0000-000000000002}";
const UID_NEW = "{CCCCCCCC-0000-0000-0000-000000000003}";
const UID_NEWER = "{DDDDDDDD-0000-0000-0000-000000000004}";

function task(id: string, caption: string, extra: Partial<TaskNode> = {}): TaskNode {
  return { id, Caption: caption, Places: [], DependsOn: [], Children: [], Path: [caption], Depth: 0, ...extra };
}

function todoRow(values: Record<string, string>) {
  return { section: "TodoItems", values: TODO_ITEMS_HEADER.map((column) => values[column] ?? "") };
}

function write(writeId: string, ...rows: PendingRows["rows"][number][]): PendingRows {
  return { writeId, rows };
}

/** The export the overlay composes onto: two top-level tasks, one with a child. */
function exported(): TaskNode[] {
  const child = task("1.1", "child", { Guid: UID_B, Path: ["alpha", "child"], Depth: 1 });
  return [task("1", "alpha", { Guid: UID_A, Children: [child] }), task("2", "beta")];
}

describe("pending-write overlay", () => {
  it("returns the export untouched when nothing is pending", () => {
    const tasks = exported();
    expect(overlayPendingWrites(tasks, [])).toBe(tasks);
  });

  it("shows an added task as a phantom under its authored parent", () => {
    const overlaid = overlayPendingWrites(exported(), [
      write("w1", todoRow({ UID: UID_NEW, ParentUID: UID_A, Caption: "phantom" })),
    ]);
    const phantom = flatten(overlaid).find((t) => t.Caption === "phantom")!;
    expect(phantom.pending).toBe(true);
    expect(phantom.writeId).toBe("w1");
    // Positional fields are re-derived, so the id addresses the task it names.
    expect(phantom.id).toBe("1.2");
    expect(phantom.Path).toEqual(["alpha", "phantom"]);
    expect(phantom.Depth).toBe(1);
    expect(overlaid[0]!.Children).toHaveLength(2);
  });

  it("keeps a whole added subtree together, parent row before child row", () => {
    const overlaid = overlayPendingWrites(exported(), [
      write(
        "w1",
        todoRow({ UID: UID_NEW, Caption: "project" }),
        todoRow({ UID: UID_NEWER, ParentUID: UID_NEW, Caption: "step" }),
      ),
    ]);
    const project = overlaid.find((t) => t.Caption === "project")!;
    expect(project.id).toBe("3");
    expect(project.Children.map((c) => c.Caption)).toEqual(["step"]);
    expect(project.Children[0]!.id).toBe("3.1");
  });

  it("lands a phantom at the top level when its parent is nowhere to be found", () => {
    const overlaid = overlayPendingWrites(exported(), [
      write("w1", todoRow({ UID: UID_NEW, ParentUID: "{EEEEEEEE-0000-0000-0000-000000000009}", Caption: "orphan" })),
    ]);
    expect(overlaid.map((t) => t.Caption)).toEqual(["alpha", "beta", "orphan"]);
  });

  it("merges an update onto the exported task and flags it pending", () => {
    const overlaid = overlayPendingWrites(exported(), [
      write("w7", todoRow({ UID: UID_B, ParentUID: UID_A, Caption: "renamed", Note: "why", Starred: "1", DueDateTime: "2026-08-01 09:00" })),
    ]);
    const updated = overlaid[0]!.Children[0]!;
    expect(updated.Caption).toBe("renamed");
    expect(updated.Note).toBe("why");
    expect(updated.Starred).toBe(true);
    expect(updated.DueDateTime).toBe("2026-08-01 09:00");
    expect(updated.pending).toBe(true);
    expect(updated.writeId).toBe("w7");
    // The rename is positional truth too: Path follows the caption.
    expect(updated.Path).toEqual(["alpha", "renamed"]);
  });

  it("clears a field the authored row leaves empty — the row is complete", () => {
    const withNote = exported();
    withNote[1]!.Note = "stale";
    withNote[1]!.Guid = UID_NEW;
    const overlaid = overlayPendingWrites(withNote, [write("w1", todoRow({ UID: UID_NEW, Caption: "beta" }))]);
    expect(overlaid[1]!.Note).toBeUndefined();
  });

  it("keeps a caption rather than clearing it — every other field can be empty, that one cannot", () => {
    const overlaid = overlayPendingWrites(exported(), [
      write("w1", todoRow({ UID: UID_B, ParentUID: UID_A, Note: "note only" }), todoRow({ UID: UID_NEW, ParentUID: UID_A })),
    ]);
    const updated = overlaid[0]!.Children[0]!;
    expect(updated.Caption).toBe("child");
    expect(updated.Note).toBe("note only");
    expect(overlaid[0]!.Children[1]!.Caption).toBe("");
  });

  it("never overwrites the export with a false flag or a raw relation UID", () => {
    const starred = exported();
    starred[1]!.Guid = UID_NEW;
    starred[1]!.Places = ["@Office"];
    const overlaid = overlayPendingWrites(starred, [
      write("w1", todoRow({ UID: UID_NEW, Caption: "beta", HideInToDo: "0" })),
    ]);
    expect(overlaid[1]!.HideInToDo).toBeUndefined();
    expect(overlaid[1]!.Places).toEqual(["@Office"]);
  });

  it("shows a completion as completed", () => {
    const overlaid = overlayPendingWrites(exported(), [
      write("w1", todoRow({ UID: UID_B, ParentUID: UID_A, Caption: "child", CompletionDateTime: "2026-07-27 10:00" })),
    ]);
    expect(overlaid[0]!.Children[0]!.CompletionDateTime).toBe("2026-07-27 10:00");
  });

  it("hides a tombstoned task and its whole subtree", () => {
    const overlaid = overlayPendingWrites(exported(), [
      { writeId: "w1", rows: [{ section: "TodoItems.Deleted", values: [normalizeGuid(UID_A)] }] },
    ]);
    expect(overlaid.map((t) => t.Caption)).toEqual(["beta"]);
    // beta takes the vacated slot: ids are positional, and the overlay keeps
    // them addressable rather than leaving a hole.
    expect(overlaid[0]!.id).toBe("1");
  });

  it("lets a later write win over an earlier one on the same task", () => {
    const overlaid = overlayPendingWrites(exported(), [
      write("w1", todoRow({ UID: UID_B, ParentUID: UID_A, Caption: "first" })),
      write("w2", todoRow({ UID: UID_B, ParentUID: UID_A, Caption: "second" })),
    ]);
    expect(overlaid[0]!.Children[0]!.Caption).toBe("second");
    expect(overlaid[0]!.Children[0]!.writeId).toBe("w2");
  });

  it("re-parents a pending move, taking the subtree with it", () => {
    const tasks = exported();
    tasks[1]!.Guid = UID_NEW;
    const overlaid = overlayPendingWrites(tasks, [
      // The child's own row, re-authored under the second top-level task.
      write("w1", todoRow({ UID: UID_B, ParentUID: UID_NEW, Caption: "child" })),
    ]);
    const beta = overlaid.find((t) => t.Caption === "beta")!;
    expect(overlaid[0]!.Children).toHaveLength(0);
    expect(beta.Children.map((c) => c.Caption)).toEqual(["child"]);
    expect(beta.Children[0]!.id).toBe("2.1");
    expect(beta.Children[0]!.pending).toBe(true);
  });

  it("moves a task to the top level when its authored row names no parent", () => {
    const overlaid = overlayPendingWrites(exported(), [write("w1", todoRow({ UID: UID_B, Caption: "child" }))]);
    expect(overlaid.map((t) => t.Caption)).toEqual(["alpha", "beta", "child"]);
    expect(overlaid[0]!.Children).toHaveLength(0);
  });

  it("stops overlaying a write whose TTL has passed — the deadline is the promise", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const overlaid = overlayPendingWrites(exported(), [
      { writeId: "w1", expiresAt: past, rows: [todoRow({ UID: UID_NEW, Caption: "phantom" })] },
    ]);
    // The resident sweeps the queue lazily, so a read can meet a write that is
    // past its deadline but still on disk. It is not pending any more.
    expect(overlaid.map((t) => t.Caption)).toEqual(["alpha", "beta"]);
  });

  it("drops the entry silently once the write is no longer queued", () => {
    const tasks = exported();
    const queued = overlayPendingWrites(tasks, [write("w1", todoRow({ UID: UID_B, ParentUID: UID_A, Caption: "renamed" }))]);
    expect(queued[0]!.Children[0]!.Caption).toBe("renamed");
    // Expiry/supersede is not a state the overlay stores: the write leaves the
    // queue and the read reverts to export truth, saying nothing about it.
    const drained = overlayPendingWrites(tasks, []);
    expect(drained[0]!.Children[0]!.Caption).toBe("child");
    expect(drained[0]!.Children[0]!.pending).toBeUndefined();
  });

  it("never mutates the export it was given", () => {
    const tasks = exported();
    overlayPendingWrites(tasks, [
      write("w1", todoRow({ UID: UID_B, ParentUID: UID_A, Caption: "renamed" }), todoRow({ UID: UID_NEW, ParentUID: UID_A, Caption: "phantom" })),
    ]);
    expect(tasks[0]!.Children).toHaveLength(1);
    expect(tasks[0]!.Children[0]!.Caption).toBe("child");
    expect(tasks[0]!.Children[0]!.pending).toBeUndefined();
  });
});

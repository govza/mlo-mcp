import { describe, expect, it } from "vitest";
import { OutlineService, type OutlineWrite, type TaskSpec } from "../../src/services/outline.js";
import { IdentityService } from "../../src/services/identity.js";
import {
  itemIndexAt,
  parseCaptureLine,
  updatePatch,
  completionPatch,
  reopenPatch,
} from "../../src/services/outline-authoring.js";
import { documentFromDeltaRows, normalizeGuid, TODO_ITEMS_HEADER } from "../../src/cloud/delta.js";
import { findSection, type SectionedCsv } from "../../src/cloud/csv.js";
import { repoFailure, type DeltaRow } from "../../src/repo/mlo-repository.js";
import { failed } from "../../src/result.js";
import type { CapturedRow } from "../../src/cloud/row-store.js";
import type { TaskNode } from "../../src/types.js";
import type { MloDocument } from "../../src/xml.js";
import { FakeMloRepository } from "../fakes/fake-mlo-repository.js";
import { FakeRowStore } from "../fakes/fake-row-store.js";

/**
 * OutlineService's write policy against fakes only (spec section 8): no
 * repository, no resident, no vendor protocol — the rules that make a write
 * sensible, and the typed refusals that stop one.
 */

const UID_ROOT = "{AAAAAAAA-0000-0000-0000-000000000001}";
const UID_CHILD = "{BBBBBBBB-0000-0000-0000-000000000002}";
const UID_OTHER = "{CCCCCCCC-0000-0000-0000-000000000003}";
const PLACE_HOME = "{DDDDDDDD-0000-0000-0000-000000000004}";
const FLAG_HOT = "{EEEEEEEE-0000-0000-0000-000000000005}";

function task(id: string, caption: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    Caption: caption,
    Places: [],
    DependsOn: [],
    Children: [],
    Path: [caption],
    Depth: 0,
    ...extra,
  } as TaskNode;
}

/** A full 82-column row, as capture would have seen it. */
function fullRow(uid: string, overrides: Record<string, string> = {}): string[] {
  const cells = TODO_ITEMS_HEADER.map((column) => overrides[column] ?? "");
  cells[TODO_ITEMS_HEADER.indexOf("UID")] = normalizeGuid(uid);
  return cells;
}

function capturedRow(cells: string[]): CapturedRow {
  return { header: TODO_ITEMS_HEADER, cells, capturedAt: "2026-07-27T10:00:00", source: "vendor-get", placeUids: [], dependencyUids: [] };
}

interface Harness {
  outline: OutlineService;
  repo: FakeMloRepository;
  rows: FakeRowStore;
  /** The rows of the last accepted write, rebuilt into a delta document. */
  written(): SectionedCsv;
  writtenRows(): DeltaRow[];
}

function harness(tasks: TaskNode[] = []): Harness {
  const repo = new FakeMloRepository();
  repo.tasks = tasks;
  repo.doc = {} as MloDocument;
  const rows = new FakeRowStore();
  const outline = new OutlineService(repo, new IdentityService(rows.view()), rows);
  let accepted: DeltaRow[] = [];
  const write = repo.write.bind(repo);
  repo.write = async (delta) => {
    accepted = delta;
    return write(delta);
  };
  return {
    outline,
    repo,
    rows,
    writtenRows: () => accepted,
    written: () => documentFromDeltaRows(accepted),
  };
}

function value(result: OutlineWrite) {
  if (result.isErrored) throw new Error(`expected an accepted write, got ${result.failure.kind}: ${result.failure.detail}`);
  return result.value;
}

function failure(result: OutlineWrite) {
  if (!result.isErrored) throw new Error("expected a refusal");
  return result.failure;
}

function taskRow(document: SectionedCsv, index = 0): Record<string, string> {
  const section = findSection(document, "TodoItems")!;
  const row = section.rows[index]!;
  return Object.fromEntries(section.header.map((column, i) => [column, row[i] ?? ""]));
}

describe("outline authoring (pure)", () => {
  it("only writes the columns a patch names, always stamping LastModified", () => {
    const row = capturedRow(fullRow(UID_ROOT, { Caption: "old", Starred: "0", ScheduleType: "0" }));
    const columns = updatePatch({ Caption: "new" }, row, "2026-07-27T12:00:00");
    expect(columns).toEqual({ Caption: "new", LastModified: "2026-07-27T12:00:00" });
  });

  it("turns dates on and off with ScheduleType, and stamps a star toggle", () => {
    const row = capturedRow(fullRow(UID_ROOT, { Starred: "0", ScheduleType: "0", DueDateTime: "" }));
    expect(updatePatch({ DueDateTime: "2026-08-01T15:00:00" }, row, "now").ScheduleType).toBe("1");
    const scheduled = capturedRow(fullRow(UID_ROOT, { ScheduleType: "1", DueDateTime: "2026-08-01T15:00:00" }));
    expect(updatePatch({ DueDateTime: "" }, scheduled, "now").ScheduleType).toBe("0");
    expect(updatePatch({ Starred: true }, row, "now").StarToggleDateTime).toBe("now");
    const starred = capturedRow(fullRow(UID_ROOT, { Starred: "1" }));
    expect(updatePatch({ Starred: true }, starred, "now").StarToggleDateTime).toBeUndefined();
  });

  it("completes a project into ProjectStatus 3 and reopens it to 0", () => {
    const project = capturedRow(fullRow(UID_ROOT, { IsProject: "1" }));
    expect(completionPatch(project, "now")).toMatchObject({ CompletionDateTime: "now", ProjectStatus: "3" });
    const completed = capturedRow(fullRow(UID_ROOT, { ProjectStatus: "3" }));
    expect(reopenPatch(completed, "now")).toMatchObject({ CompletionDateTime: "", ProjectStatus: "0" });
    const plain = capturedRow(fullRow(UID_ROOT, { ProjectStatus: "0" }));
    expect(reopenPatch(plain, "now").ProjectStatus).toBeUndefined();
  });

  it("places a task among its siblings, appending by default", () => {
    expect(itemIndexAt([100, 200])).toBe(300);
    expect(itemIndexAt([])).toBe(100);
    expect(itemIndexAt([100, 200], 0)).toBe(50);
    expect(itemIndexAt([100, 200], 1)).toBe(150);
    expect(itemIndexAt([100, 200], 9)).toBe(300);
    // Adjacent neighbours leave no midpoint: take the slot itself.
    expect(itemIndexAt([100, 101], 1)).toBe(101);
    // Ahead of a sibling already at 0 there is nothing to halve: step below it.
    expect(itemIndexAt([0, 100], 0)).toBe(-100);
  });

  it("parses the rapid-entry subset it claims and nothing more", () => {
    expect(parseCaptureLine("call the dentist @Phone")).toEqual({ caption: "call the dentist", places: ["Phone"] });
    expect(parseCaptureLine("write spec\n\nwith details")).toEqual({
      caption: "write spec",
      places: [],
      note: "with details",
    });
    // An unparsed rapid-entry token stays in the caption rather than being guessed at.
    expect(parseCaptureLine("pay rent !2").caption).toBe("pay rent !2");
  });
});

describe("OutlineService.add", () => {
  it("authors a full row and accepts it, returning the receipt", async () => {
    const h = harness();
    const receipt = value(await h.outline.add({ caption: "new task" }));
    expect(receipt.writeId).toBeTruthy();
    expect(receipt.expiresAt).toBeTruthy();
    const row = taskRow(h.written());
    expect(row.Caption).toBe("new task");
    expect(row.UID).toBe(receipt.uids[0]);
    expect(row.ItemIndex).toBe("100");
    // The defaults MLO itself emits for a new plain task, not blanks.
    expect(row.Importance).toBe("100");
    expect(row.Effort).toBe("50");
  });

  it("nests a batch by key and links dependencies within it", async () => {
    const h = harness();
    const specs: TaskSpec[] = [
      { key: "parent", caption: "project", IsProject: true },
      { key: "first", caption: "step one", parentKey: "parent" },
      { key: "second", caption: "step two", parentKey: "parent", dependsOnKeys: ["first"] },
    ];
    const receipt = value(await h.outline.addMany(specs));
    expect(receipt.uids).toHaveLength(3);
    const document = h.written();
    const rows = findSection(document, "TodoItems")!;
    const parentUid = taskRow(document, 0).UID;
    expect(rows.rows).toHaveLength(3);
    expect(taskRow(document, 1).ParentUID).toBe(parentUid);
    // Siblings created in one batch keep input order.
    expect(Number(taskRow(document, 2).ItemIndex)).toBeGreaterThan(Number(taskRow(document, 1).ItemIndex));
    const dependencies = findSection(document, "TodoItems.Dependency")!;
    expect(dependencies.rows).toEqual([[receipt.uids[2], receipt.uids[1]]]);
    expect(h.repo.quickSyncs).toBe(0); // the repository owns the nudge, not the service
  });

  it("appends after the existing siblings' captured ItemIndex values", async () => {
    const child = task("1.1", "existing child", { Guid: UID_CHILD, Depth: 1 });
    const parent = task("1", "parent", { Guid: UID_ROOT, Children: [child] });
    const h = harness([parent]);
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT, { ItemIndex: "100" }));
    h.rows.setRow(UID_CHILD, [...TODO_ITEMS_HEADER], fullRow(UID_CHILD, { ItemIndex: "700" }));
    value(await h.outline.add({ caption: "next child", parentId: "1" }));
    expect(taskRow(h.written()).ItemIndex).toBe("800");
  });

  it("appends past siblings the row store has never seen instead of colliding with them", async () => {
    const seen = task("1.1", "seen", { Guid: UID_CHILD, Depth: 1 });
    const unseen = task("1.2", "never captured", { Guid: UID_OTHER, Depth: 1 });
    const h = harness([task("1", "parent", { Guid: UID_ROOT, Children: [seen, unseen] })]);
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT));
    h.rows.setRow(UID_CHILD, [...TODO_ITEMS_HEADER], fullRow(UID_CHILD, { ItemIndex: "100" }));
    value(await h.outline.add({ caption: "third child", parentId: "1" }));
    // One unseen sibling occupies a slot: append a step past it, not onto 200.
    expect(taskRow(h.written()).ItemIndex).toBe("300");
  });

  it("refuses an unknown context caption rather than inventing one", async () => {
    const h = harness();
    const refused = failure(await h.outline.add({ caption: "task", Places: ["@Nowhere"] }));
    expect(refused.kind).toBe("invalid-request");
    expect(refused.detail).toContain("@Nowhere");
  });

  it("refuses a malformed batch before anything is authored", async () => {
    const h = harness();
    const cycle = failure(
      await h.outline.addMany([
        { key: "a", caption: "a", parentKey: "b" },
        { key: "b", caption: "b", parentKey: "a" },
      ]),
    );
    expect(cycle.kind).toBe("invalid-request");
    expect(cycle.detail).toContain("cycle");
    expect(h.writtenRows()).toHaveLength(0);
  });
});

describe("OutlineService.capture", () => {
  it("defaults a captured line into the profile's inbox", async () => {
    const inbox = task("2", "<Inbox>", { Guid: UID_OTHER });
    const h = harness([task("1", "Business", { Guid: UID_ROOT }), inbox]);
    h.rows.setPlace(PLACE_HOME, "Home");
    value(await h.outline.capture("buy milk @Home"));
    const document = h.written();
    expect(taskRow(document).Caption).toBe("buy milk");
    expect(taskRow(document).ParentUID).toBe(normalizeGuid(UID_OTHER));
    expect(findSection(document, "TodoItemPlaces")!.rows).toEqual([[taskRow(document).UID, normalizeGuid(PLACE_HOME)]]);
  });

  it("falls back to the top level when the profile has no inbox", async () => {
    const h = harness([task("1", "Business", { Guid: UID_ROOT })]);
    value(await h.outline.capture("stray thought"));
    expect(taskRow(h.written()).ParentUID).toBe("");
  });
});

describe("OutlineService rewrites", () => {
  const target = task("1", "existing", { Guid: UID_ROOT });

  it("authors update from the row store's latest captured row, keeping every other column", async () => {
    const h = harness([target]);
    h.rows.setRow(
      UID_ROOT,
      [...TODO_ITEMS_HEADER],
      fullRow(UID_ROOT, { Caption: "old caption", Note: "keep me", Importance: "150" }),
      { placeUids: [PLACE_HOME] },
    );
    value(await h.outline.update("1", { Caption: "new caption" }));
    const document = h.written();
    const row = taskRow(document);
    expect(row.Caption).toBe("new caption");
    expect(row.Note).toBe("keep me");
    expect(row.Importance).toBe("150");
    // Relations ride along untouched: omitting them would clear the contexts.
    expect(findSection(document, "TodoItemPlaces")!.rows).toEqual([[normalizeGuid(UID_ROOT), normalizeGuid(PLACE_HOME)]]);
  });

  it("replaces the whole context list, so an empty list clears them", async () => {
    const h = harness([target]);
    h.rows.setPlace(PLACE_HOME, "Home");
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT), { placeUids: [PLACE_HOME] });
    value(await h.outline.update("1", { Places: [] }));
    expect(findSection(h.written(), "TodoItemPlaces")!.rows).toEqual([]);
    value(await h.outline.update("1", { Places: ["home"] }));
    expect(findSection(h.written(), "TodoItemPlaces")!.rows).toEqual([[normalizeGuid(UID_ROOT), normalizeGuid(PLACE_HOME)]]);
  });

  it("resolves a flag caption and clears it with an empty string", async () => {
    const h = harness([target]);
    h.rows.setFlag(FLAG_HOT, "Hot");
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT));
    value(await h.outline.update("1", { Flag: "hot" }));
    expect(taskRow(h.written()).FlagUID).toBe(normalizeGuid(FLAG_HOT));
    value(await h.outline.update("1", { Flag: "" }));
    expect(taskRow(h.written()).FlagUID).toBe("");
  });

  it("surfaces the typed unknown-row refusal with the repull remedy on a row-store miss", async () => {
    const h = harness([target]);
    const refused = failure(await h.outline.update("1", { Caption: "no row for this" }));
    expect(refused.kind).toBe("unknown-row");
    expect(refused.remedy).toBe("repull");
    expect(refused.retryable).toBe("after-user-action");
    expect(h.writtenRows()).toHaveLength(0);
  });

  it("refuses an id the snapshot cannot resolve", async () => {
    const h = harness([target, task("2", "no guid recovered")]);
    expect(failure(await h.outline.update("9", { Caption: "x" })).kind).toBe("target-unresolvable");
    expect(failure(await h.outline.update("2", { Caption: "x" })).kind).toBe("target-unresolvable");
  });

  it("completes a task, and refuses a recurring one so MLO keeps the series", async () => {
    const h = harness([target]);
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT));
    value(await h.outline.complete("1"));
    expect(taskRow(h.written()).CompletionDateTime).toBeTruthy();

    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT, { RecType: "2" }));
    const refused = failure(await h.outline.complete("1"));
    expect(refused.kind).toBe("unsupported-edit");
    expect(refused.detail).toContain("recurring");
    // Non-date edits on a recurring task are still fine.
    value(await h.outline.update("1", { Caption: "renamed" }));
    expect(failure(await h.outline.update("1", { DueDateTime: "2026-08-01T09:00:00" })).kind).toBe("unsupported-edit");
  });

  it("reopens a completed task", async () => {
    const h = harness([target]);
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT, { CompletionDateTime: "2026-07-01T09:00:00" }));
    value(await h.outline.uncomplete("1"));
    expect(taskRow(h.written()).CompletionDateTime).toBe("");
  });

  it("keeps a starred task's manual order and gives a newly starred one the next slot", async () => {
    const h = harness([target]);
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT, { Starred: "1" }), { starredOrderIndex: "700" });
    value(await h.outline.update("1", { Caption: "still starred" }));
    expect(findSection(h.written(), "TodoView.ManualOrdering.Starred")!.rows).toEqual([[normalizeGuid(UID_ROOT), "700"]]);

    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT, { Starred: "0" }));
    value(await h.outline.update("1", { Starred: true }));
    expect(findSection(h.written(), "TodoView.ManualOrdering.Starred")!.rows).toEqual([[normalizeGuid(UID_ROOT), "500"]]);
  });

  it("moves a task under a new parent and into a slot, refusing its own subtree", async () => {
    const child = task("1.1", "child", { Guid: UID_CHILD, Depth: 1 });
    const parent = task("1", "parent", { Guid: UID_ROOT, Children: [child] });
    const destination = task("2", "elsewhere", { Guid: UID_OTHER });
    const h = harness([parent, destination]);
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT));
    h.rows.setRow(UID_CHILD, [...TODO_ITEMS_HEADER], fullRow(UID_CHILD));

    value(await h.outline.move("1.1", "2"));
    expect(taskRow(h.written()).ParentUID).toBe(normalizeGuid(UID_OTHER));

    // A fresh harness for the refusal: the move above is already in h's next
    // read (read-your-own-writes), so its ids have shifted — which is exactly
    // why path ids are only good for the call after the read that produced them.
    const fresh = harness([task("1", "parent", { Guid: UID_ROOT, Children: [task("1.1", "child", { Guid: UID_CHILD, Depth: 1 })] })]);
    fresh.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT));
    fresh.rows.setRow(UID_CHILD, [...TODO_ITEMS_HEADER], fullRow(UID_CHILD));
    const refused = failure(await fresh.outline.move("1", "1.1"));
    expect(refused.kind).toBe("invalid-request");
    expect(refused.detail).toContain("own subtree");
  });

  it("moving to the top level clears ParentUID", async () => {
    const child = task("1.1", "child", { Guid: UID_CHILD, Depth: 1 });
    const h = harness([task("1", "parent", { Guid: UID_ROOT, Children: [child] })]);
    h.rows.setRow(UID_CHILD, [...TODO_ITEMS_HEADER], fullRow(UID_CHILD));
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT, { ItemIndex: "100" }));
    value(await h.outline.move("1.1"));
    expect(taskRow(h.written()).ParentUID).toBe("");
    expect(taskRow(h.written()).ItemIndex).toBe("200");
  });

  it("routes the Organize verbs through the same authoring path", async () => {
    const h = harness([target, task("2", "blocker", { Guid: UID_OTHER })]);
    h.rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT));
    value(await h.outline.makeProject("1"));
    expect(taskRow(h.written()).IsProject).toBe("1");
    value(await h.outline.setSequential("1", true));
    expect(taskRow(h.written()).CompleteInOrder).toBe("1");
    value(await h.outline.setDependencies("1", ["2"]));
    expect(findSection(h.written(), "TodoItems.Dependency")!.rows).toEqual([
      [normalizeGuid(UID_ROOT), normalizeGuid(UID_OTHER)],
    ]);
    expect(failure(await h.outline.setDependencies("1", ["1"])).detail).toContain("cannot depend on itself");
  });
});

describe("OutlineService.delete", () => {
  it("tombstones the task and its whole subtree", async () => {
    const child = task("1.1", "child", { Guid: UID_CHILD, Depth: 1 });
    const h = harness([task("1", "parent", { Guid: UID_ROOT, Children: [child] })]);
    const receipt = value(await h.outline.delete("1"));
    expect(receipt.uids).toEqual([normalizeGuid(UID_ROOT), normalizeGuid(UID_CHILD)]);
    expect(findSection(h.written(), "TodoItems.Deleted")!.rows).toEqual([
      [normalizeGuid(UID_ROOT)],
      [normalizeGuid(UID_CHILD)],
    ]);
    // Deletes need no captured row: a tombstone carries only the UID.
    expect(await h.rows.size()).toBe(0);
  });

  it("refuses when any descendant has no recoverable GUID, rather than orphaning it", async () => {
    const child = task("1.1", "unrecovered child", { Depth: 1 });
    const h = harness([task("1", "parent", { Guid: UID_ROOT, Children: [child] })]);
    expect(failure(await h.outline.delete("1")).kind).toBe("target-unresolvable");
    expect(h.writtenRows()).toHaveLength(0);
  });
});

describe("OutlineService refusals from below", () => {
  it("refuses every write while the profile is unbound", async () => {
    const repo = new FakeMloRepository();
    const outline = new OutlineService(repo, new IdentityService(new FakeRowStore().view()));
    const refused = failure(await outline.add({ caption: "nowhere to go" }));
    expect(refused.kind).toBe("partition-not-ready");
    expect(refused.retryable).toBe("after-user-action");
    expect(refused.remedy).toMatch(/sync/);
  });

  it("carries a repository write refusal through as a value", async () => {
    const h = harness();
    h.repo.write = async () =>
      failed(repoFailure("endpoint-down", "the resident endpoint is not answering"));
    // Forwarded under its own name, not re-wrapped: the caller reads the kind
    // the contract table declares, and its remedy with it.
    const refused = failure(await h.outline.add({ caption: "will not land" }));
    expect(refused.kind).toBe("endpoint-down");
    expect(refused.retryable).toBe(true);
    expect(refused.remedy).toBeTruthy();
  });
});

import { describe, it, expect } from "vitest";
import { IdentityService } from "../../src/services/identity.js";
import type { Snapshot } from "../../src/repo/mlo-repository.js";
import type { TaskNode } from "../../src/types.js";
import type { MloDocument } from "../../src/xml.js";
import { FakeRowStore } from "../fakes/fake-row-store.js";

const UID_A = "{AAAAAAAA-0000-0000-0000-000000000001}";
const UID_B = "{BBBBBBBB-0000-0000-0000-000000000002}";

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

function snapshotOf(tasks: TaskNode[]): Snapshot {
  return { doc: {} as MloDocument, tasks, at: 0 };
}

describe("IdentityService", () => {
  const withGuid = task("1", "annotated", { Guid: UID_A, DependsOn: [UID_B.toLowerCase()] });
  const target = task("2", "dependency target", { Guid: UID_B });
  const bare = task("3", "no guid recovered");
  const snap = snapshotOf([withGuid, target, bare]);

  it("builds exactly one resolver per snapshot", () => {
    const identity = new IdentityService(new FakeRowStore().view());
    expect(identity.resolverFor(snap)).toBe(identity.resolverFor(snap));
    expect(identity.resolverFor(snapshotOf([]))).not.toBe(identity.resolverFor(snap));
  });

  it("resolves confirmed when the row store holds the UID", () => {
    const rows = new FakeRowStore();
    rows.set(UID_A, "annotated");
    const resolution = new IdentityService(rows.view()).resolverFor(snap).uidFor("1");
    expect(resolution).toEqual({ kind: "resolved", uid: UID_A, confidence: "confirmed" });
  });

  it("resolves unconfirmed on a row-store gap — never a guess", () => {
    const resolution = new IdentityService(new FakeRowStore().view()).resolverFor(snap).uidFor("1");
    expect(resolution).toEqual({ kind: "resolved", uid: UID_A, confidence: "unconfirmed" });
  });

  it("refuses with a typed reason for an unknown id and for a task without a recovered GUID", () => {
    const resolver = new IdentityService(new FakeRowStore().view()).resolverFor(snap);
    expect(resolver.uidFor("9.9")).toMatchObject({ kind: "unresolvable", reason: "unknown-id" });
    expect(resolver.uidFor("3")).toMatchObject({ kind: "unresolvable", reason: "no-recoverable-guid" });
  });

  it("looks up tasks by UID case-insensitively and finds dependents", () => {
    const resolver = new IdentityService(new FakeRowStore().view()).resolverFor(snap);
    expect(resolver.taskFor(UID_B.toLowerCase())?.Caption).toBe("dependency target");
    expect(resolver.dependentsOf(UID_B).map((t) => t.id)).toEqual(["1"]);
  });
});

describe("structural alignment (the identity authority)", () => {
  const UID_1 = "{11111111-0000-0000-0000-000000000001}";
  const UID_2 = "{22222222-0000-0000-0000-000000000002}";
  const UID_3 = "{33333333-0000-0000-0000-000000000003}";

  it("resolves a GUID-less export against captured rows positionally, children included", () => {
    const rows = new FakeRowStore();
    rows.set(UID_1, "parent", { itemIndex: 100 });
    rows.set(UID_2, "child", { parentUid: UID_1, itemIndex: 100 });
    rows.set(UID_3, "sibling", { itemIndex: 200 });
    const child = task("1.1", "child", { Depth: 1, Path: ["parent", "child"] });
    const parent = task("1", "parent", { Children: [child] });
    const sibling = task("2", "sibling");
    const resolver = new IdentityService(rows.view()).resolverFor(snapshotOf([parent, sibling]));
    // No task carries a binary GUID — the zero-footer profile.
    expect(resolver.uidFor("1")).toEqual({ kind: "resolved", uid: UID_1, confidence: "confirmed" });
    expect(resolver.uidFor("1.1")).toEqual({ kind: "resolved", uid: UID_2, confidence: "confirmed" });
    expect(resolver.uidFor("2")).toEqual({ kind: "resolved", uid: UID_3, confidence: "confirmed" });
    expect(resolver.taskFor(UID_2)?.id).toBe("1.1");
  });

  it("orders cloud siblings by ItemIndex, not row order", () => {
    const rows = new FakeRowStore();
    rows.set(UID_2, "second", { itemIndex: 200 });
    rows.set(UID_1, "first", { itemIndex: 100 });
    const resolver = new IdentityService(rows.view()).resolverFor(
      snapshotOf([task("1", "first"), task("2", "second")]),
    );
    expect(resolver.uidFor("1")).toMatchObject({ uid: UID_1 });
    expect(resolver.uidFor("2")).toMatchObject({ uid: UID_2 });
  });

  it("in a drifted slot pairs only captions unique on both sides — duplicates refuse", () => {
    const rows = new FakeRowStore();
    rows.set(UID_1, "twin", { itemIndex: 100 });
    rows.set(UID_2, "twin", { itemIndex: 200 });
    rows.set(UID_3, "lone", { itemIndex: 300 });
    // Export has one fewer child: counts differ, so positional pairing is off.
    const resolver = new IdentityService(rows.view()).resolverFor(
      snapshotOf([task("1", "twin"), task("2", "lone")]),
    );
    expect(resolver.uidFor("1")).toMatchObject({ kind: "unresolvable", reason: "no-recoverable-guid" });
    expect(resolver.uidFor("2")).toEqual({ kind: "resolved", uid: UID_3, confidence: "confirmed" });
  });

  it("structural wins over a contradicting binary GUID", () => {
    const rows = new FakeRowStore();
    rows.set(UID_1, "aligned", { itemIndex: 100 });
    const resolver = new IdentityService(rows.view()).resolverFor(
      snapshotOf([task("1", "aligned", { Guid: UID_2 })]),
    );
    expect(resolver.uidFor("1")).toEqual({ kind: "resolved", uid: UID_1, confidence: "confirmed" });
    expect(resolver.taskFor(UID_1)?.id).toBe("1");
  });

  it("falls back to the binary GUID only where alignment left the node unplaced", () => {
    const rows = new FakeRowStore();
    rows.set(UID_1, "twin", { itemIndex: 100 });
    rows.set(UID_2, "twin", { itemIndex: 200 });
    // Drifted slot + duplicate caption: unplaceable structurally, but this one
    // carries a recovered GUID.
    const resolver = new IdentityService(rows.view()).resolverFor(
      snapshotOf([task("1", "twin", { Guid: UID_2 })]),
    );
    expect(resolver.uidFor("1")).toEqual({ kind: "resolved", uid: UID_2, confidence: "confirmed" });
  });
});

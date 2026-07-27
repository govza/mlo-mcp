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

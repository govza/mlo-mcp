import { describe, expect, it } from "vitest";
import { addTaskTool } from "../../src/tools/add-task.js";
import { updateTaskTool } from "../../src/tools/update-task.js";
import { completeTaskTool } from "../../src/tools/complete-task.js";
import { deleteTaskTool } from "../../src/tools/delete-task.js";
import { moveTaskTool } from "../../src/tools/move-task.js";
import { listTasksTool } from "../../src/tools/list-tasks.js";
import { writeStatusTool } from "../../src/tools/write-status.js";
import { cloudStatusTool } from "../../src/tools/cloud-status.js";
import { allTools } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/contract.js";
import { OutlineService } from "../../src/services/outline.js";
import { IdentityService } from "../../src/services/identity.js";
import { normalizeGuid } from "../../src/cloud/guid.js";
import { TODO_ITEMS_HEADER } from "../../src/cloud/mlo-schema.js";
import type { WriteStatus } from "../../src/repo/mlo-repository.js";
import type { TaskNode } from "../../src/types.js";
import type { MloDocument } from "../../src/xml.js";
import { FakeMloRepository } from "../fakes/fake-mlo-repository.js";
import { FakeRowStore } from "../fakes/fake-row-store.js";

/**
 * The MCP caller's view of the write path (spec section 2, tool-facing
 * contract): accept-and-return, the five-state receipt, and reads that already
 * show what was accepted.
 */

const UID_ROOT = "{AAAAAAAA-0000-0000-0000-000000000001}";
const UID_CHILD = "{BBBBBBBB-0000-0000-0000-000000000002}";

function task(id: string, caption: string, extra: Partial<TaskNode> = {}): TaskNode {
  return { id, Caption: caption, Places: [], DependsOn: [], Children: [], Path: [caption], Depth: 0, ...extra };
}

function fullRow(uid: string, caption: string): string[] {
  return TODO_ITEMS_HEADER.map((column) =>
    column === "UID" ? normalizeGuid(uid) : column === "Caption" ? caption : "",
  );
}

interface Rig {
  ctx: ToolContext;
  repo: FakeMloRepository;
}

function rig(): Rig {
  const repo = new FakeMloRepository();
  const child = task("1.1", "child", { Guid: UID_CHILD, Path: ["root", "child"], Depth: 1 });
  repo.tasks = [task("1", "root", { Guid: UID_ROOT, Children: [child] })];
  repo.doc = {} as MloDocument;
  const rows = new FakeRowStore();
  rows.setRow(UID_ROOT, [...TODO_ITEMS_HEADER], fullRow(UID_ROOT, "root"));
  rows.setRow(UID_CHILD, [...TODO_ITEMS_HEADER], fullRow(UID_CHILD, "child"));
  const outline = new OutlineService(repo, new IdentityService(rows.view()), rows);
  return { ctx: { config: {}, outline } as unknown as ToolContext, repo };
}

function structured<T = Record<string, unknown>>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

interface Accept {
  uid: string;
  uids?: string[];
  caption: string;
  writeId: string;
  status: string;
  expiresAt: string;
  message: string;
}

async function captions(ctx: ToolContext): Promise<Array<{ id: string; Caption: string; pending?: boolean; writeId?: string }>> {
  const listed = await listTasksTool.execute({ includeCompleted: true }, ctx);
  return structured<{ tasks: Array<{ id: string; Caption: string; pending?: boolean; writeId?: string }> }>(listed).tasks;
}

describe("write tools answer at durable accept", () => {
  it("returns the receipt without waiting on delivery, and never a verified flag", async () => {
    const { ctx, repo } = rig();
    const result = await addTaskTool.execute({ caption: "new thing" }, ctx);
    const accept = structured<Accept>(result);
    expect(result.isError).toBeUndefined();
    expect(accept.status).toBe("accepted");
    expect(accept.writeId).toBeTruthy();
    expect(accept.expiresAt).toBeTruthy();
    expect(accept.uid).toMatch(/^\{[0-9A-F-]+\}$/);
    expect(accept).not.toHaveProperty("verified");
    // Nothing waits on MLO: no QuickSync-then-re-export round trip in the tool.
    expect(repo.quickSyncs).toBe(0);
    expect(accept.message).toContain("expires at");
  });

  it("no write tool advertises a verified field", () => {
    const writes = allTools.filter((tool) => !tool.annotations.readOnlyHint && tool.name !== "sync");
    expect(writes.length).toBeGreaterThan(5);
    for (const tool of writes) expect(Object.keys(tool.outputSchema)).not.toContain("verified");
  });

  it("names every uid a batch addressed, and only when there is more than one", async () => {
    const { ctx } = rig();
    const single = structured<Accept>(await addTaskTool.execute({ caption: "one" }, ctx));
    expect(single.uids).toBeUndefined();
    const branch = structured<Accept>(await deleteTaskTool.execute({ id: "1" }, ctx));
    expect(branch.uids).toEqual([normalizeGuid(UID_ROOT), normalizeGuid(UID_CHILD)]);
    expect(branch.uid).toBe(normalizeGuid(UID_ROOT));
  });

  it("turns a refusal into one sentence naming the kind and the remedy", async () => {
    const { ctx, repo } = rig();
    repo.writeRefuses = "endpoint-down";
    const result = await addTaskTool.execute({ caption: "nope" }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("[endpoint-down]");
  });
});

describe("GUID write targets and the caption echo", () => {
  it("update_task accepts the task's stable GUID as the target", async () => {
    const { ctx } = rig();
    const result = await updateTaskTool.execute({ id: UID_CHILD, Caption: "renamed" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(structured<Accept>(result).uid).toBe(normalizeGuid(UID_CHILD));
  });

  it("refuses a GUID matching no task with target-unresolvable, never a path interpretation", async () => {
    const { ctx } = rig();
    const result = await updateTaskTool.execute(
      { id: "{99999999-0000-0000-0000-000000000099}", Caption: "nope" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("[target-unresolvable]");
  });

  it("move_task accepts a GUID for both the task and the new parent", async () => {
    const { ctx } = rig();
    const result = await moveTaskTool.execute({ id: UID_CHILD, newParentId: UID_ROOT }, ctx);
    expect(result.isError).toBeUndefined();
    expect(structured<Accept>(result).uid).toBe(normalizeGuid(UID_CHILD));
  });

  it("every accept names the caption it resolved to, in the message and the structure", async () => {
    const { ctx } = rig();
    const edited = await updateTaskTool.execute({ id: "1.1", Note: "why" }, ctx);
    const accept = structured<Accept>(edited);
    expect(accept.caption).toBe("child");
    expect(accept.message).toContain('"child"');

    const added = structured<Accept>(await addTaskTool.execute({ caption: "fresh" }, ctx));
    expect(added.caption).toBe("fresh");
    expect(added.message).toContain('"fresh"');
  });

  it("a batch accept names the first task and how many more", async () => {
    const { ctx } = rig();
    const branch = structured<Accept>(await deleteTaskTool.execute({ id: "1" }, ctx));
    expect(branch.caption).toBe("root");
    expect(branch.message).toContain('"root"');
    expect(branch.message).toContain("+1 more");
  });
});

describe("write_status", () => {
  it("answers all five states with detail, and a remedy where one exists", async () => {
    const { ctx, repo } = rig();
    const { writeId } = structured<Accept>(await addTaskTool.execute({ caption: "tracked" }, ctx));

    const queued = structured<{ status: string; detail: string; expiresAt?: string; remedy?: string }>(
      await writeStatusTool.execute({ writeId }, ctx),
    );
    expect(queued.status).toBe("accepted");
    expect(queued.detail).toContain("durably queued");
    expect(queued.expiresAt).toBeTruthy();

    const expectations: Record<Exclude<WriteStatus, "accepted">, { contains: string; remedy: boolean }> = {
      delivered: { contains: "applied", remedy: false },
      verified: { contains: "confirmed", remedy: false },
      expired: { contains: "dead-letter", remedy: true },
      superseded: { contains: "conflict", remedy: true },
    };
    for (const [status, expected] of Object.entries(expectations)) {
      repo.transition(writeId, status as WriteStatus);
      const answered = structured<{ status: string; detail: string; remedy?: string; at?: string }>(
        await writeStatusTool.execute({ writeId }, ctx),
      );
      expect(answered.status).toBe(status);
      expect(answered.detail).toContain(expected.contains);
      expect(Boolean(answered.remedy)).toBe(expected.remedy);
      expect(answered.at).toBeTruthy();
    }
  });

  it("refuses a receipt nobody issued, typed", async () => {
    const { ctx } = rig();
    const result = await writeStatusTool.execute({ writeId: "w-never-issued" }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("[unknown-write]");
  });
});

describe("read-your-own-writes through the tools", () => {
  it("shows an added task, flagged pending with its writeId", async () => {
    const { ctx } = rig();
    const { writeId, uid } = structured<Accept>(await addTaskTool.execute({ caption: "phantom", parentId: "1" }, ctx));
    const listed = await captions(ctx);
    const phantom = listed.find((t) => t.Caption === "phantom")!;
    expect(phantom.pending).toBe(true);
    expect(phantom.writeId).toBe(writeId);
    expect(uid).toBeTruthy();
  });

  it("merges an update, shows a completion, and hides a delete", async () => {
    const renamed = rig();
    await updateTaskTool.execute({ id: "1.1", Caption: "renamed" }, renamed.ctx);
    expect((await captions(renamed.ctx)).map((t) => t.Caption)).toContain("renamed");

    const done = rig();
    await completeTaskTool.execute({ id: "1.1" }, done.ctx);
    const completed = await captions(done.ctx);
    expect(completed.find((t) => t.Caption === "child")).toBeDefined();
    const listed = await listTasksTool.execute({ includeCompleted: false }, done.ctx);
    // Completed tasks are pruned from the default listing, so the completion is
    // visible as the child's disappearance from it.
    expect(JSON.stringify(structured(listed))).not.toContain("child");

    const gone = rig();
    await deleteTaskTool.execute({ id: "1.1" }, gone.ctx);
    expect((await captions(gone.ctx)).map((t) => t.Caption)).toEqual(["root"]);
  });

  it("drops the overlay entry silently once the write leaves the queue", async () => {
    const { ctx, repo } = rig();
    const { writeId } = structured<Accept>(await updateTaskTool.execute({ id: "1.1", Caption: "renamed" }, ctx));
    expect((await captions(ctx)).map((t) => t.Caption)).toContain("renamed");

    repo.transition(writeId, "expired");
    const reverted = await captions(ctx);
    expect(reverted.map((t) => t.Caption)).toEqual(["root", "child"]);
    // Silent: the read says nothing about the expiry — that is write_status's
    // and cloud_status's job.
    expect(reverted.some((t) => t.pending)).toBe(false);
  });
});

describe("cloud_status carries what nobody is waiting on", () => {
  /** The cloud plane as the tool sees it: one bound profile, two dead letters. */
  function statusCtx(): ToolContext {
    return {
      admin: {
        status: async () => ({
          isErrored: false,
          value: {
            host: "127.0.0.1", port: 8181, mode: "upstream", lifecycle: "ready",
            endpoint: { url: "http://127.0.0.1:8181", reachable: true, version: "1.0.0" },
            unboundSightings: [], stateRoot: "C:/state", partitions: [],
            writes: {
              pendingWrites: 2,
              oldestPendingAgeMs: 7 * 60_000,
              sessionHeldOpen: true,
              recentDeadLetters: [
                { writeId: "w9", uid: "{U}", caption: "call the dentist", status: "expired", at: "2026-07-27T10:00:00Z", reason: "MLO never synced" },
              ],
            },
          },
        }),
      },
    } as unknown as ToolContext;
  }

  it("reports the aggregate and says the dead letter out loud", async () => {
    const result = await cloudStatusTool.execute({}, statusCtx());
    const status = structured<{ writes: { pendingWrites: number; sessionHeldOpen?: boolean } }>(result);
    expect(status.writes.pendingWrites).toBe(2);
    expect(status.writes.sessionHeldOpen).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("2 write(s) queued");
    expect(text).toContain("oldest 7m");
    // The stall reading, not a reassuring one: a held-open session is MLO
    // waiting on a human, which is the whole point of surfacing it.
    expect(text).toContain("DELIVERY STALLED");
    expect(text).toContain("NEVER LANDED");
    expect(text).toContain("call the dentist");
  });
});

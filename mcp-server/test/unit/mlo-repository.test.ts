import { describe, it, expect } from "vitest";
import { LocalMloRepository } from "../../src/repo/local-mlo-repository.js";
import type { MloCli } from "../../src/repo/mlo-cli.js";
import type { MloConfig } from "../../src/types.js";
import { TODO_ITEMS_HEADER } from "../../src/cloud/delta.js";
import { FakeMloRepository } from "../fakes/fake-mlo-repository.js";
import { describeMloRepositoryContract } from "../contract/mlo-repository-contract.js";
import { expectOk } from "../expect-result.js";

describeMloRepositoryContract("FakeMloRepository", () => ({
  repo: new FakeMloRepository(),
  sampleRow: () => ({ section: "TodoItems.Deleted", values: ["{00000000-0000-0000-0000-000000000001}"] }),
}));

describe("FakeMloRepository hand-driven transitions", () => {
  it("walks a write through the five states", async () => {
    const repo = new FakeMloRepository();
    const { writeId } = expectOk(await repo.write([{ section: "TodoItems", values: [] }]));
    for (const state of ["delivered", "verified", "expired", "superseded"] as const) {
      repo.transition(writeId, state);
      expect(expectOk(await repo.status(writeId)).status).toBe(state);
    }
  });
});

function xmlWithTask(caption: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<MyLifeOrganized-xml ver="1.2">' +
    `<TaskTree><TaskNode Caption=""><TaskNode Caption="${caption}"/></TaskNode></TaskTree>` +
    "</MyLifeOrganized-xml>"
  );
}

function deferred(): { promise: Promise<string>; resolve(value: string): void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}

/** Driver stub whose exports resolve under test control (for cache-race tests). */
class ScriptedMloCli implements MloCli {
  private readonly exports: Promise<string>[] = [];
  private next = 0;
  exportCalls = 0;
  quickSyncs = 0;

  queueExport(promise: Promise<string>): void {
    this.exports.push(promise);
  }
  exportXml(): Promise<string> {
    this.exportCalls++;
    const scripted = this.exports[this.next++];
    if (!scripted) throw new Error("no export scripted");
    return scripted;
  }
  async quickSync(): Promise<void> {
    this.quickSyncs++;
  }
  readDataFile(): Promise<Buffer> {
    return Promise.reject(new Error("no binary in this test"));
  }
}

const config = { cacheStaleMs: 60_000 } as MloConfig;

describe("LocalMloRepository snapshot coalescing", () => {
  it("coalesces concurrent stale reads onto one export", async () => {
    const cli = new ScriptedMloCli();
    const first = deferred();
    cli.queueExport(first.promise);
    const repo = new LocalMloRepository(config, cli);
    const [a, b] = [repo.snapshot(), repo.snapshot()];
    first.resolve(xmlWithTask("only"));
    expect(expectOk(await a).tasks[0]?.Caption).toBe("only");
    expect(expectOk(await b)).toBe(expectOk(await a));
    expect(cli.exportCalls).toBe(1);
  });

  it("fresh=true does not reuse an in-flight refresh that predates a mutation", async () => {
    const cli = new ScriptedMloCli();
    const preMutation = deferred();
    const postMutation = deferred();
    cli.queueExport(preMutation.promise);
    cli.queueExport(postMutation.promise);
    const repo = new LocalMloRepository(config, cli);

    const staleRead = repo.snapshot(); // export starts before the mutation applies
    repo.invalidate();
    const verification = repo.snapshot(true);

    postMutation.resolve(xmlWithTask("after write"));
    expect(expectOk(await verification).tasks[0]?.Caption).toBe("after write");

    // the superseded refresh resolves late and must not clobber the newer snapshot
    preMutation.resolve(xmlWithTask("before write"));
    expect(expectOk(await staleRead).tasks[0]?.Caption).toBe("before write");
    expect(expectOk(await repo.snapshot()).tasks[0]?.Caption).toBe("after write");
    expect(cli.exportCalls).toBe(2);
  });

  it("quickSync drops the cached snapshot so the next read re-exports", async () => {
    const cli = new ScriptedMloCli();
    cli.queueExport(Promise.resolve(xmlWithTask("before")));
    cli.queueExport(Promise.resolve(xmlWithTask("after")));
    const repo = new LocalMloRepository(config, cli);
    expect(expectOk(await repo.snapshot()).tasks[0]?.Caption).toBe("before");
    await repo.quickSync();
    expect(cli.quickSyncs).toBe(1);
    expect(expectOk(await repo.snapshot()).tasks[0]?.Caption).toBe("after");
  });
});

describe("LocalMloRepository pending-write overlay", () => {
  const queued = (writeId: string, uid: string, caption: string) => ({
    writeId,
    rows: [
      {
        section: "TodoItems",
        values: TODO_ITEMS_HEADER.map((column) => (column === "UID" ? uid : column === "Caption" ? caption : "")),
      },
    ],
  });

  it("composes the queue onto the export, flagged pending", async () => {
    const cli = new ScriptedMloCli();
    cli.queueExport(Promise.resolve(xmlWithTask("exported")));
    const queue = { pending: async () => [queued("w1", "{11111111-0000-0000-0000-000000000001}", "phantom")] };
    const repo = new LocalMloRepository(config, cli, undefined, queue);
    const tasks = expectOk(await repo.snapshot()).tasks;
    expect(tasks.map((t) => t.Caption)).toEqual(["exported", "phantom"]);
    expect(tasks[1]!.pending).toBe(true);
    expect(tasks[1]!.writeId).toBe("w1");
  });

  it("re-derives the overlay per read, so a drained queue needs no invalidation", async () => {
    const cli = new ScriptedMloCli();
    cli.queueExport(Promise.resolve(xmlWithTask("exported")));
    let pending = [queued("w1", "{11111111-0000-0000-0000-000000000001}", "phantom")];
    const repo = new LocalMloRepository(config, cli, undefined, { pending: async () => pending });
    expect(expectOk(await repo.snapshot()).tasks).toHaveLength(2);
    pending = [];
    // Same cached export (one exportCall), overlay gone: the entry drops silently.
    expect(expectOk(await repo.snapshot()).tasks.map((t) => t.Caption)).toEqual(["exported"]);
    expect(cli.exportCalls).toBe(1);
  });

  it("serves export truth when the queue cannot be read — a read is not that fault's surface", async () => {
    const cli = new ScriptedMloCli();
    cli.queueExport(Promise.resolve(xmlWithTask("exported")));
    const repo = new LocalMloRepository(config, cli, undefined, {
      pending: () => Promise.reject(new Error("state root gone")),
    });
    expect(expectOk(await repo.snapshot()).tasks.map((t) => t.Caption)).toEqual(["exported"]);
  });
});

describe("LocalMloRepository without a ResidentClient", () => {
  it("refuses writes loudly in a read-only wiring", async () => {
    const repo = new LocalMloRepository(config, new ScriptedMloCli());
    await expect(repo.write([])).rejects.toThrow(/without a ResidentClient/);
    await expect(repo.status("w1")).rejects.toThrow(/without a ResidentClient/);
  });
});

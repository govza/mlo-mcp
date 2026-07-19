import { describe, it, expect, vi, beforeEach } from "vitest";
import { MloStore } from "../../src/store.js";
import { exportXml } from "../../src/mlo-cli.js";
import type { MloConfig } from "../../src/types.js";

vi.mock("../../src/mlo-cli.js", () => ({
  exportXml: vi.fn(),
  readDataFile: vi.fn(() => Promise.reject(new Error("no binary in this test"))),
}));

const exportMock = vi.mocked(exportXml);

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

const config = { cacheStaleMs: 60_000 } as MloConfig;

beforeEach(() => exportMock.mockReset());

describe("MloStore refresh coalescing", () => {
  it("coalesces concurrent stale reads onto one export", async () => {
    const first = deferred();
    exportMock.mockReturnValueOnce(first.promise);
    const store = new MloStore(config);
    const [a, b] = [store.getSnapshot(), store.getSnapshot()];
    first.resolve(xmlWithTask("only"));
    expect((await a).tasks[0]?.Caption).toBe("only");
    expect(await b).toBe(await a);
    expect(exportMock).toHaveBeenCalledTimes(1);
  });

  it("fresh=true does not reuse an in-flight refresh that predates a mutation", async () => {
    const preMutation = deferred();
    const postMutation = deferred();
    exportMock.mockReturnValueOnce(preMutation.promise).mockReturnValueOnce(postMutation.promise);
    const store = new MloStore(config);

    const staleRead = store.getSnapshot(); // export starts before the mutation applies
    store.invalidate();
    const verification = store.getSnapshot(true);

    postMutation.resolve(xmlWithTask("after write"));
    expect((await verification).tasks[0]?.Caption).toBe("after write");

    // the superseded refresh resolves late and must not clobber the newer snapshot
    preMutation.resolve(xmlWithTask("before write"));
    expect((await staleRead).tasks[0]?.Caption).toBe("before write");
    expect((await store.getSnapshot()).tasks[0]?.Caption).toBe("after write");
    expect(exportMock).toHaveBeenCalledTimes(2);
  });
});

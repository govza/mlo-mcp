import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudState } from "../../src/cloud/state.js";
import { parseCursor } from "../../src/cloud/cursor.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

describe("CloudState", () => {
  it("persists appends and reloads bigint cursors beyond Number.MAX_SAFE_INTEGER", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-state-")); dirs.push(dir);
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ highWater: "9007199254740993", entries: [] }));
    const first = new CloudState(dir);
    const cursor = await first.append("mcp", new Uint8Array([1, 2, 3]));
    expect(cursor).toBe(9007199254740994n);
    expect(await first.highWater()).toBe(cursor);
    const reloaded = new CloudState(dir);
    expect(await reloaded.highWater()).toBe(cursor);
    const [entry] = await reloaded.entriesAfter(parseCursor("9007199254740993"));
    expect(Array.from(entry!.bytes)).toEqual([1, 2, 3]);
  });

  it("tracks last pull cursor per origin and pending counts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-state-")); dirs.push(dir);
    const state = new CloudState(dir);
    const first = await state.append("mcp", new Uint8Array([1]));
    await state.append("mcp", new Uint8Array([2]));
    expect(await state.pendingFor("app")).toBe(2);
    await state.recordPull("app", first);
    expect(await state.pendingFor("app")).toBe(1);
    // recordPull never regresses, and survives a reload
    await state.recordPull("app", parseCursor("0"));
    const reloaded = new CloudState(dir);
    expect(await reloaded.lastPullCursor("app")).toBe(first);
    expect(await reloaded.pendingFor("app")).toBe(1);
  });

  it("rebases a fresh local log above an existing app cursor exactly once", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-state-")); dirs.push(dir);
    const state = new CloudState(dir);
    await state.append("mcp", new Uint8Array([1]));
    await state.append("mcp", new Uint8Array([2]));

    await state.adoptInitialBaseline("app", parseCursor("100"));
    expect(await state.highWater()).toBe(102n);
    expect((await state.entriesAfter(parseCursor("100"), "app")).map((entry) => entry.cursor)).toEqual([101n, 102n]);

    await state.recordPull("app", parseCursor("102"));
    await expect(state.adoptInitialBaseline("app", parseCursor("200")))
      .rejects.toThrow("newer than an initialized local cloud state");
    const reloaded = new CloudState(dir);
    expect(await reloaded.highWater()).toBe(102n);
    expect((await reloaded.entriesAfter(parseCursor("100"), "app")).map((entry) => Array.from(entry.bytes)))
      .toEqual([[1], [2]]);
  });

  it("reloads under a cross-process lock before one instance mutates another instance's state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-state-")); dirs.push(dir);
    const serverState = new CloudState(dir);
    const toolState = new CloudState(dir);
    await serverState.append("mcp", new Uint8Array([1]));
    expect(await toolState.highWater()).toBe(1n);
    await toolState.append("mcp", new Uint8Array([2]));

    // This used to overwrite toolState's cursor 2 from serverState's stale
    // in-memory cursor 1 when the long-running server finalized a session.
    await serverState.finalize();
    const reloaded = new CloudState(dir);
    expect(await reloaded.highWater()).toBe(2n);
    expect(await reloaded.counts()).toEqual({ mcp: 2, app: 0 });
  });
});

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
});

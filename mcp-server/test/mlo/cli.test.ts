import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mloInstalled, assertGuiClosed, makeTestEnv, type TestEnv } from "./helpers.js";
import { exportXml, readDataFile } from "../../src/mlo-cli.js";
import { parseMloXml } from "../../src/xml.js";
import { buildTaskTree, flatten } from "../../src/task-tree.js";
import { annotateGuids } from "../../src/guids.js";

describe.skipIf(!mloInstalled)("mlo.exe integration", () => {
  let env: TestEnv;

  beforeAll(() => {
    assertGuiClosed();
    env = makeTestEnv();
  });
  afterAll(() => env?.cleanup());

  it("exports a parseable tree with the demo tasks", async () => {
    const xml = await exportXml(env.config);
    const tasks = flatten(buildTaskTree(parseMloXml(xml)));
    expect(tasks.length).toBeGreaterThan(50);
    expect(tasks.some((t) => t.Caption === "Business and Career")).toBe(true);
  });

  it("returns exit code 2 when the -saveXML target exists", async () => {
    // exportXml pre-deletes its target, so call mlo.exe directly
    const target = path.join(env.dir, "exists.xml");
    await fs.writeFile(target, "occupied", "utf8");
    const { execFile } = await import("node:child_process");
    const code = await new Promise<number>((resolve) => {
      execFile(
        env.config.mloExePath,
        [env.config.dataFile, `-saveXML=${target}`, "-console"],
        { windowsHide: true, timeout: 60_000 },
        (err) => resolve(err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0)
      );
    });
    expect(code).toBe(2);
  });

  it("recovers GUIDs for most tasks, and never the same one twice (E4)", async () => {
    const xml = await exportXml(env.config);
    const tasks = buildTaskTree(parseMloXml(xml));
    const count = annotateGuids(await readDataFile(env.config), tasks);
    const all = flatten(tasks);

    // Coverage is state-dependent and deliberately not maximised: a task
    // written through the cloud delta has a caption but no GUID footer until
    // MLO re-serializes it, and annotateGuids drops the whole ancestor chain
    // it sits in rather than guess which node the remaining footers belong to.
    expect(count / all.length).toBeGreaterThan(0.8);

    const guid = all.find((t) => t.Guid)?.Guid;
    expect(guid).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);

    // The real invariant: a stolen footer shows up as two tasks claiming one
    // GUID, which silently retargets writes and deletes at another subtree.
    const guids = all.map((t) => t.Guid).filter(Boolean);
    expect(new Set(guids).size).toBe(guids.length);
  });
});

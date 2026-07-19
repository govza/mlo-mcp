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

  it("recovers GUIDs for >90% of tasks (E4)", async () => {
    const xml = await exportXml(env.config);
    const tasks = buildTaskTree(parseMloXml(xml));
    const count = annotateGuids(await readDataFile(env.config), tasks);
    const all = flatten(tasks);
    expect(count / all.length).toBeGreaterThan(0.9);
    const guid = all.find((t) => t.Guid)?.Guid;
    expect(guid).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
  });
});

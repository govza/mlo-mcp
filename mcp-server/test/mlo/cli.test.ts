import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { mloInstalled, assertGuiClosed, makeTestEnv, type TestEnv } from "./helpers.js";
import { exportXml, addTask, convertXmlToMl, MloError, readDataFile } from "../../src/mlo-cli.js";
import { parseMloXml, buildMloXml } from "../../src/xml.js";
import { buildTaskTree, flatten } from "../../src/task-tree.js";
import { annotateGuids } from "../../src/guids.js";
import { replaceDataFile } from "../../src/write-pipeline.js";
import { findRawById, findById } from "../../src/task-tree.js";
import { setRawField } from "../../src/xml.js";

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

  it("adds a parsed task with date and context", async () => {
    // NOTE: digits in a caption derail MLO's -Parse tokenizer (unparsed tokens
    // fold into the caption), so the unique suffix is letters-only.
    const caption = `itest-${Date.now().toString().replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`;
    await addTask(env.config, `"${caption}" tomorrow 2pm @Office -i2`, { parse: true });
    const tasks = flatten(buildTaskTree(parseMloXml(await exportXml(env.config))));
    const t = tasks.find((x) => x.Caption === caption);
    expect(t).toBeDefined();
    expect(t!.DueDateTime).toMatch(/T14:00:00$/);
    expect(t!.Places).toContain("@Office");
    expect(t!.Importance).toBe(50); // -iN maps to (N-1)*50 on MLO's 0–200 scale
  });

  it("returns exit code 2 when the -saveXML target exists", async () => {
    // exportXml/convertXmlToMl pre-delete their targets, so call mlo.exe directly
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

  it("adds a subtask under a GUID-targeted parent (E2)", async () => {
    const xml = await exportXml(env.config);
    const tasks = buildTaskTree(parseMloXml(xml));
    annotateGuids(await readDataFile(env.config), tasks);
    const parent = flatten(tasks).find((t) => t.Caption === "PMI certification" && t.Guid);
    expect(parent).toBeDefined();
    const caption = `guid-child-${Date.now()}`;
    await addTask(env.config, caption, { parentGuid: parent!.Guid });
    const after = flatten(buildTaskTree(parseMloXml(await exportXml(env.config))));
    const child = after.find((t) => t.Caption === caption);
    expect(child).toBeDefined();
    expect(child!.Path.slice(0, -1)).toContain("PMI certification");
  });

  it("round-trips XML→ML→XML losslessly (E1)", async () => {
    const xml = await exportXml(env.config);
    const marker = `roundtrip-${Date.now()}`;
    const edited = xml.replace('Caption="PMI certification"', `Caption="${marker}"`);
    const tempXml = path.join(env.dir, "rt.xml");
    const tempMl = path.join(env.dir, "rt.ml");
    await fs.writeFile(tempXml, edited, "utf8");
    await convertXmlToMl(env.config, tempXml, tempMl);
    const rtConfig = { ...env.config, dataFile: tempMl };
    const rtTasks = flatten(buildTaskTree(parseMloXml(await exportXml(rtConfig))));
    expect(rtTasks.some((t) => t.Caption === marker)).toBe(true);
    const origTasks = flatten(buildTaskTree(parseMloXml(xml)));
    expect(rtTasks.length).toBe(origTasks.length);
  });

  it("accepts our rebuilt XML (fxp build → -saveML)", async () => {
    const doc = parseMloXml(await exportXml(env.config));
    const tempXml = path.join(env.dir, "rebuilt.xml");
    const tempMl = path.join(env.dir, "rebuilt.ml");
    await fs.writeFile(tempXml, buildMloXml(doc), "utf8");
    await convertXmlToMl(env.config, tempXml, tempMl);
    const rtConfig = { ...env.config, dataFile: tempMl };
    const before = flatten(buildTaskTree(doc));
    const after = flatten(buildTaskTree(parseMloXml(await exportXml(rtConfig))));
    expect(after.length).toBe(before.length);
    expect(after.map((t) => t.Caption)).toEqual(before.map((t) => t.Caption));
  });

  it("write pipeline completes a task and keeps a backup (Phase 3)", async () => {
    const tasks = buildTaskTree(parseMloXml(await exportXml(env.config)));
    const target = flatten(tasks).find((t) => !t.CompletionDateTime && t.Children.length === 0)!;
    const stamp = "2026-07-17T12:00:00";
    const { backupPath } = await replaceDataFile(
      env.config,
      (doc) => setRawField(findRawById(doc, target.id)!.raw, "CompletionDateTime", stamp),
      (after) => findById(after, target.id)?.CompletionDateTime === stamp
    );
    expect((await fs.stat(backupPath)).size).toBeGreaterThan(0);
    const after = flatten(buildTaskTree(parseMloXml(await exportXml(env.config))));
    expect(after.find((t) => t.Caption === target.Caption)?.CompletionDateTime).toBe(stamp);
    await fs.rm(backupPath, { force: true });
  });

  it("write pipeline restores the backup when verification fails", async () => {
    const before = await fs.readFile(env.config.dataFile);
    await expect(
      replaceDataFile(
        env.config,
        () => undefined, // no mutation
        () => false // force verification failure
      )
    ).rejects.toThrow(MloError);
    const after = await fs.readFile(env.config.dataFile);
    expect(after.equals(before)).toBe(true);
  });
});

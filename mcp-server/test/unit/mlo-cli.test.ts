import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mloArgs, MloError, SystemMloCli } from "../../src/repo/mlo-cli.js";
import type { MloConfig } from "../../src/types.js";
import { FakeMloCli } from "../fakes/fake-mlo-cli.js";

let dir: string;
let config: MloConfig;
let fake: FakeMloCli;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cli-test-"));
  const dataFile = path.join(dir, "work.ml");
  await fs.writeFile(dataFile, "not a real .ml file");
  config = { dataFile, exportDir: path.join(dir, "exports"), mloExePath: "C:\\fake\\mlo.exe" } as MloConfig;
  fake = new FakeMloCli(dataFile);
  // the stale-registry state in which trap 1 fires on any pathless invocation
  fake.registryLastDbFile = path.join(dir, "old-profile.ml");
});

afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe("mloArgs (the two live CLI traps)", () => {
  it("refuses a pathless invocation (trap 1: silent no-op against a stale registry profile)", () => {
    expect(() => mloArgs("", ["-QuickSync"])).toThrow(/pathless/);
  });

  it("refuses bare arguments that would parse as <FileToOpen> (trap 2: second instance)", () => {
    // the classic slip: -AddSubtask "caption" instead of -AddSubtask="caption"
    expect(() => mloArgs(config.dataFile, ["-AddSubtask", "Buy milk"])).toThrow(/second MLO instance/);
  });

  it("always ends the line with -console so mlo.exe exits instead of staying resident", () => {
    expect(mloArgs(config.dataFile, ["-QuickSync"])).toEqual([config.dataFile, "-QuickSync", "-console"]);
  });

  it("the traps are real: FakeMloCli reproduces what an unguarded line would do", async () => {
    await fake.exec(config.mloExePath, ["-QuickSync", "-console"], 1000); // pathless
    expect(fake.silentNoOps).toBe(1);
    await fake.exec(config.mloExePath, ["Buy milk", "-console"], 1000); // caption as <FileToOpen>
    expect(fake.secondInstances).toEqual(["Buy milk"]);
    // the missing-`=` slip with the path present is an invalid command line
    await expect(fake.exec(config.mloExePath, [config.dataFile, "Buy milk", "-console"], 1000)).rejects.toThrow(
      /invalid command-line/
    );
  });
});

describe("SystemMloCli against the simulated app", () => {
  it("exportXml passes the explicit data-file path and returns the exported XML", async () => {
    const cli = new SystemMloCli(config, fake.exec);
    const xml = await cli.exportXml();
    expect(xml).toBe(fake.exportContent);
    expect(fake.invocations[0]?.[0]).toBe(config.dataFile);
    expect(fake.silentNoOps).toBe(0);
    expect(fake.secondInstances).toEqual([]);
  });

  it("quickSync reaches the running app, never a second instance", async () => {
    const cli = new SystemMloCli(config, fake.exec);
    await cli.quickSync();
    expect(fake.quickSyncs).toBe(1);
    expect(fake.silentNoOps).toBe(0);
    expect(fake.secondInstances).toEqual([]);
  });

  it("surfaces scripted mlo.exe exit codes as MloError", async () => {
    fake.failNext(2);
    const cli = new SystemMloCli(config, fake.exec);
    await expect(cli.exportXml()).rejects.toSatisfy((e: unknown) => e instanceof MloError && e.exitCode === 2);
  });

  it("cleans up the export target even when the invocation fails", async () => {
    fake.failNext(3);
    const cli = new SystemMloCli(config, fake.exec);
    await expect(cli.exportXml()).rejects.toThrow();
    expect(await fs.readdir(config.exportDir)).toEqual([]);
  });
});

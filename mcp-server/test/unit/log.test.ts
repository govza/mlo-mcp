import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { log, mirrorLogToFile, stopLogMirror } from "../../src/log.js";

/**
 * The resident is spawned detached with its stdio discarded, so its stderr
 * log survives nowhere. The mirror is the fix: every `log()` line is also
 * appended to a file under the state root.
 */

const dirs: string[] = [];
afterEach(async () => {
  stopLogMirror();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-log-"));
  dirs.push(dir);
  return dir;
}

describe("the log mirror", () => {
  it("appends every log line to the file, timestamped", async () => {
    const file = path.join(await tempDir(), "resident.log");
    mirrorLogToFile(file);

    log("auto-initialization declined (no-open-profile): cannot tell");

    const written = await fs.readFile(file, "utf8");
    expect(written).toContain("auto-initialization declined (no-open-profile): cannot tell");
    // Timestamped: the whole point is reconstructing WHEN a bind declined.
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rotates an oversized log aside instead of growing it forever", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "resident.log");
    await fs.writeFile(file, "x".repeat(3 * 1024 * 1024));

    mirrorLogToFile(file);
    log("fresh line");

    expect((await fs.readFile(file, "utf8")).length).toBeLessThan(1024);
    expect(await fs.readFile(`${file}.old`, "utf8")).toContain("xxx");
  });

  it("rotates while running too — the resident lives for weeks between restarts", async () => {
    const file = path.join(await tempDir(), "resident.log");
    mirrorLogToFile(file);

    const chunk = "y".repeat(64 * 1024);
    for (let line = 0; line < 40; line += 1) log(chunk);

    expect((await fs.stat(file)).size).toBeLessThan(2 * 1024 * 1024);
    expect((await fs.stat(`${file}.old`)).size).toBeGreaterThan(1024 * 1024);
  });

  it("never lets an unwritable mirror break logging itself", async () => {
    const dir = await tempDir();
    // A FILE where the parent directory should be: unwritable however hard we try.
    await fs.writeFile(path.join(dir, "blocker"), "");
    mirrorLogToFile(path.join(dir, "blocker", "resident.log"));
    expect(() => log("still fine")).not.toThrow();
  });
});

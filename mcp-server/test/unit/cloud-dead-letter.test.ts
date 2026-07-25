import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeadLetterStore, type DeadLetter } from "../../src/cloud/dead-letter.js";

/**
 * The marker file's own guarantees. The refusal paths that fill it are driven
 * through the tool surface in cloud-binding-mismatch.test.ts; what is asserted
 * here is that nothing gets lost on the way in.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-dead-letter-"));
  dirs.push(dir);
  return dir;
}

function letter(content: string): DeadLetter {
  return { at: "2026-07-25T04:00:00.000Z", tool: "add_tasks", reason: "binding mismatch", content };
}

describe("dead letters", () => {
  it("keeps every capture when separate processes record at the same moment", async () => {
    const stateRoot = await root();
    // One store per process: a state root is shared by every MCP session on
    // the machine, and the refusal that needs the vendor contact fires in
    // precisely the sessions that do not own the endpoint — so concurrent
    // writers are the normal case here, not an edge one.
    const sessions = [0, 1, 2, 3, 4].map(() => new DeadLetterStore(stateRoot));

    await Promise.all(sessions.map((session, n) => session.record(letter(`session ${n} capture`))));

    const all = await new DeadLetterStore(stateRoot).all();
    expect(all.map((entry) => entry.content).sort()).toEqual([
      "session 0 capture",
      "session 1 capture",
      "session 2 capture",
      "session 3 capture",
      "session 4 capture",
    ]);
  });

  it("drops the oldest rather than growing without limit", async () => {
    const store = new DeadLetterStore(await root());
    for (let n = 0; n < 60; n += 1) await store.record(letter(`capture ${n}`));

    const all = await store.all();
    expect(all.length).toBeLessThan(60);
    expect(all.at(-1)!.content).toBe("capture 59");
    expect(all.map((entry) => entry.content)).not.toContain("capture 0");
  });

  it("caps one enormous note instead of letting a single entry grow the file", async () => {
    const store = new DeadLetterStore(await root());
    await store.record(letter("x".repeat(50_000)));

    const [only] = await store.all();
    expect(only!.content.length).toBeLessThan(50_000);
    expect(only!.content).toMatch(/truncated/);
  });

  it("reads as empty when the marker has never been written", async () => {
    expect(await new DeadLetterStore(await root()).all()).toEqual([]);
  });
});

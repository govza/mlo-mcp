import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mloInstalled, assertGuiClosed, makeTestEnv, type TestEnv } from "./helpers.js";

const SERVER_ROOT = path.resolve(__dirname, "..", "..");

describe.skipIf(!mloInstalled)("MCP server E2E over stdio", () => {
  let env: TestEnv;
  let client: Client;

  beforeAll(async () => {
    assertGuiClosed();
    env = makeTestEnv();
    client = new Client({ name: "e2e-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/index.ts"],
        cwd: SERVER_ROOT,
        env: {
          ...process.env,
          MLO_DATA_FILE: env.config.dataFile,
          MLO_EXE_PATH: env.config.mloExePath,
          MLO_EXPORT_DIR: env.config.exportDir,
        },
        stderr: "pipe",
      })
    );
  });

  afterAll(async () => {
    await client?.close();
    env?.cleanup();
  });

  it("lists the expected tools with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["add_task", "complete_task", "delete_task", "get_task", "list_tasks", "search_tasks", "sync", "update_task"]
    );
    const list = tools.find((t) => t.name === "list_tasks")!;
    expect(list.annotations?.readOnlyHint).toBe(true);
    expect(list.outputSchema).toBeDefined();
    const del = tools.find((t) => t.name === "delete_task")!;
    expect(del.annotations?.destructiveHint).toBe(true);
  });

  it("runs a list → add → list cycle", async () => {
    const first = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(first.isError).toBeFalsy();
    const structured = first.structuredContent as { tasks: Array<{ id: string; Caption: string }> };
    expect(structured.tasks.length).toBeGreaterThan(30);

    const caption = `e2e-task-${Date.now()}`;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const added = await client.callTool({
      name: "add_task",
      arguments: { caption, dueDate: `${tomorrow}T09:00`, contexts: ["Office"], importance: 4 },
    });
    expect(added.isError).toBeFalsy();
    const out = added.structuredContent as {
      task?: { id: string; DueDateTime?: string; Places: string[]; Importance?: number };
      method: string;
    };
    expect(out.method).toBe("xml"); // GUI closed + ISO date → deterministic path
    expect(out.task).toBeDefined();
    expect(out.task!.DueDateTime).toBe(`${tomorrow}T09:00:00`);
    expect(out.task!.Places).toContain("@Office");
    expect(out.task!.Importance).toBe(150);

    const second = await client.callTool({ name: "search_tasks", arguments: { query: caption } });
    const found = (second.structuredContent as { tasks: Array<{ Caption: string }>; total: number });
    expect(found.total).toBe(1);
    expect(found.tasks[0].Caption).toBe(caption);
  });

  it("get_task returns details and children ids", async () => {
    const projects = await client.callTool({ name: "search_tasks", arguments: { isProject: true } });
    const proj = (projects.structuredContent as { tasks: Array<{ id: string }> }).tasks[0];
    const got = await client.callTool({ name: "get_task", arguments: { id: proj.id } });
    expect(got.isError).toBeFalsy();
    const task = (got.structuredContent as { task: { id: string; IsProject?: boolean } }).task;
    expect(task.id).toBe(proj.id);
    expect(task.IsProject).toBe(true);
  });

  it("completes and deletes a task through the write pipeline", async () => {
    const caption = `e2e-victim-${Date.now()}`;
    await client.callTool({ name: "add_task", arguments: { caption } });
    const search = await client.callTool({ name: "search_tasks", arguments: { query: caption } });
    const victim = (search.structuredContent as { tasks: Array<{ id: string }> }).tasks[0];

    const done = await client.callTool({ name: "complete_task", arguments: { id: victim.id } });
    expect(done.isError).toBeFalsy();
    const doneOut = done.structuredContent as { ok: boolean; backupPath: string };
    expect(doneOut.ok).toBe(true);

    const research = await client.callTool({ name: "search_tasks", arguments: { query: caption, completed: true } });
    const again = (research.structuredContent as { tasks: Array<{ id: string }>; total: number });
    expect(again.total).toBe(1);

    const del = await client.callTool({ name: "delete_task", arguments: { id: again.tasks[0].id } });
    expect(del.isError).toBeFalsy();
    const gone = await client.callTool({ name: "search_tasks", arguments: { query: caption } });
    expect((gone.structuredContent as { total: number }).total).toBe(0);

    // remove the two backups the pipeline made for this test
    const { promises: fs } = await import("node:fs");
    for (const p of [doneOut.backupPath, (del.structuredContent as { backupPath: string }).backupPath]) {
      await fs.rm(p, { force: true });
    }
  });

  it("creates a deep subtree in one call and re-parents a task", async () => {
    const caption = `e2e-tree-${Date.now()}`;
    const added = await client.callTool({
      name: "add_task",
      arguments: { caption, subtasks: "Phase 1\n  Step A\n    Detail A1\n  Step B\nPhase 2" },
    });
    expect(added.isError).toBeFalsy();
    const parent = (added.structuredContent as { task?: { id: string } }).task!;
    const got = await client.callTool({ name: "get_task", arguments: { id: parent.id } });
    const children = (got.structuredContent as { task: { children: Array<{ id: string; Caption: string }> } }).task.children;
    expect(children.map((c) => c.Caption)).toEqual(["Phase 1", "Phase 2"]);

    const deep = await client.callTool({ name: "search_tasks", arguments: { query: "Detail A1" } });
    const deepTask = (deep.structuredContent as { tasks: Array<{ id: string; parentPath: string }> }).tasks[0];
    expect(deepTask.parentPath).toBe(`${caption} > Phase 1 > Step A`);

    // re-parent: move "Phase 2" under "Phase 1"
    const phase2 = children.find((c) => c.Caption === "Phase 2")!;
    const phase1 = children.find((c) => c.Caption === "Phase 1")!;
    const moved = await client.callTool({
      name: "update_task",
      arguments: { id: phase2.id, moveToParentId: phase1.id },
    });
    expect(moved.isError).toBeFalsy();
    const after = await client.callTool({ name: "search_tasks", arguments: { query: "Phase 2" } });
    expect((after.structuredContent as { tasks: Array<{ parentPath: string }> }).tasks[0].parentPath).toBe(
      `${caption} > Phase 1`
    );

    // cleanup: delete the whole tree
    const fresh = await client.callTool({ name: "search_tasks", arguments: { query: caption } });
    const freshId = (fresh.structuredContent as { tasks: Array<{ id: string }> }).tasks[0].id;
    const del = await client.callTool({ name: "delete_task", arguments: { id: freshId } });
    expect(del.isError).toBeFalsy();
    const { promises: fs } = await import("node:fs");
    for (const r of [moved, del]) await fs.rm((r.structuredContent as { backupPath: string }).backupPath, { force: true });
  });

  it("sets, reports and clears dependencies", async () => {
    const stamp = Date.now();
    await client.callTool({
      name: "add_task",
      arguments: { caption: `e2e-dep-parent-${stamp}`, subtasks: "buy parts\ninstall parts" },
    });
    const search = async (q: string) =>
      ((await client.callTool({ name: "search_tasks", arguments: { query: q } })).structuredContent as {
        tasks: Array<{ id: string; Caption: string }>;
      }).tasks[0];

    const install = await search("install parts");
    const buy = await search("buy parts");
    const set = await client.callTool({
      name: "update_task",
      arguments: { id: install.id, dependsOn: [buy.id] },
    });
    expect(set.isError).toBeFalsy();

    const got = await client.callTool({ name: "get_task", arguments: { id: (await search("install parts")).id } });
    const detail = (got.structuredContent as {
      task: { dependsOn: Array<{ Caption?: string }>; dependedOnBy: unknown[] };
    }).task;
    expect(detail.dependsOn.map((d) => d.Caption)).toEqual(["buy parts"]);

    const gotBuy = await client.callTool({ name: "get_task", arguments: { id: (await search("buy parts")).id } });
    const buyDetail = (gotBuy.structuredContent as { task: { dependedOnBy: Array<{ Caption: string }> } }).task;
    expect(buyDetail.dependedOnBy.map((d) => d.Caption)).toEqual(["install parts"]);

    const cleared = await client.callTool({
      name: "update_task",
      arguments: { id: (await search("install parts")).id, dependsOn: [] },
    });
    expect(cleared.isError).toBeFalsy();
    const after = await client.callTool({ name: "get_task", arguments: { id: (await search("install parts")).id } });
    expect(((after.structuredContent as { task: { dependsOn: unknown[] } }).task.dependsOn)).toEqual([]);

    // cleanup
    const parent = await search(`e2e-dep-parent-${stamp}`);
    const del = await client.callTool({ name: "delete_task", arguments: { id: parent.id } });
    const { promises: fs } = await import("node:fs");
    for (const r of [set, cleared, del]) {
      const p = (r.structuredContent as { backupPath?: string }).backupPath;
      if (p) await fs.rm(p, { force: true });
    }
  });

  it("creates a folder task (HideInToDoThisTask)", async () => {
    const caption = `e2e-folder-${Date.now()}`;
    const added = await client.callTool({ name: "add_task", arguments: { caption, folder: true } });
    expect(added.isError).toBeFalsy();
    const task = (added.structuredContent as { task?: { id: string } }).task;
    expect(task).toBeDefined();
    const got = await client.callTool({ name: "get_task", arguments: { id: task!.id } });
    const detail = (got.structuredContent as { task: { HideInToDoThisTask?: boolean } }).task;
    expect(detail.HideInToDoThisTask).toBe(true);
    // and back to a normal task via update_task
    const updated = await client.callTool({
      name: "update_task",
      arguments: { id: task!.id, HideInToDoThisTask: false },
    });
    expect(updated.isError).toBeFalsy();
    const again = await client.callTool({ name: "get_task", arguments: { id: task!.id } });
    expect((again.structuredContent as { task: { HideInToDoThisTask?: boolean } }).task.HideInToDoThisTask).toBeUndefined();
    const { promises: fs } = await import("node:fs");
    await fs.rm((updated.structuredContent as { backupPath: string }).backupPath, { force: true });
  });

  it("update_task edits fields", async () => {
    const search = await client.callTool({ name: "search_tasks", arguments: { query: "Finish the presentation" } });
    const target = (search.structuredContent as { tasks: Array<{ id: string }> }).tasks[0];
    const updated = await client.callTool({
      name: "update_task",
      arguments: { id: target.id, Note: "note set by e2e", Starred: true },
    });
    expect(updated.isError).toBeFalsy();
    const got = await client.callTool({ name: "get_task", arguments: { id: target.id } });
    const task = (got.structuredContent as { task: { Note?: string; Starred?: boolean } }).task;
    // MLO appends a trailing newline to notes on import
    expect(task.Note?.trimEnd()).toBe("note set by e2e");
    expect(task.Starred).toBe(true);
    const { promises: fs } = await import("node:fs");
    await fs.rm((updated.structuredContent as { backupPath: string }).backupPath, { force: true });
  });
});

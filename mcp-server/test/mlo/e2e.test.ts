import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mloInstalled, assertGuiClosed, makeTestEnv, type TestEnv } from "./helpers.js";

const SERVER_ROOT = path.resolve(__dirname, "..", "..");

// Write tools queue deltas and trigger QuickSync, which needs the app's sync
// proxy wired to the local endpoint — not available in this headless test env,
// so E2E covers the transport, the surface, and the read tools only.
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
          MLO_CLOUD_PORT: "0",
          MLO_CLOUD_STATE_DIR: path.join(env.dir, "messages"),
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
      ["add_task", "add_tasks", "cloud_status", "complete_task", "delete_task", "get_task", "list_contexts", "list_tasks", "search_tasks", "sync", "uncomplete_task", "update_task"]
    );
    const list = tools.find((t) => t.name === "list_tasks")!;
    expect(list.annotations?.readOnlyHint).toBe(true);
    expect(list.outputSchema).toBeDefined();
    const del = tools.find((t) => t.name === "delete_task")!;
    expect(del.annotations?.destructiveHint).toBe(true);
    // every tool states its full annotation contract
    for (const t of tools) {
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(t.annotations?.[hint], `${t.name} ${hint}`).toBeTypeOf("boolean");
      }
    }
  });

  it("exposes server instructions", async () => {
    expect(client.getInstructions()).toContain("PATH-BASED");
  });

  it("lists, searches, and gets tasks", async () => {
    const listed = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(listed.isError).toBeFalsy();
    const structured = listed.structuredContent as { tasks: Array<{ id: string; Caption: string }> };
    expect(structured.tasks.length).toBeGreaterThan(30);

    const first = structured.tasks[0]!;
    const got = await client.callTool({ name: "get_task", arguments: { id: first.id } });
    expect(got.isError).toBeFalsy();
    expect((got.structuredContent as { task: { Caption: string } }).task.Caption).toBe(first.Caption);

    const found = await client.callTool({ name: "search_tasks", arguments: { query: first.Caption.slice(0, 8) } });
    expect(found.isError).toBeFalsy();
  });

  it("reports contexts and cloud status", async () => {
    const contexts = await client.callTool({ name: "list_contexts", arguments: {} });
    expect(contexts.isError).toBeFalsy();

    const status = await client.callTool({ name: "cloud_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    const structured = status.structuredContent as { cursor: string };
    expect(structured.cursor).toMatch(/^\d+$/);
  });
});

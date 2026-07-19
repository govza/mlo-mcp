import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudClient } from "../../src/cloud/client.js";
import { ZERO_CURSOR } from "../../src/cloud/cursor.js";
import { findSection } from "../../src/cloud/csv.js";
import { buildTaskAddDelta, generateGuid } from "../../src/cloud/delta.js";
import { packEnvelope } from "../../src/cloud/envelope.js";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";

const handles: CloudServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CloudClient", () => {
  it("drives a complete app-side cloud sync cycle", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-client-")); dirs.push(dir);
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateDir: dir }); handles.push(handle);
    const client = new CloudClient({ baseUrl: `http://${handle.host}:${handle.port}` });
    expect(await client.pull(ZERO_CURSOR)).toEqual({ cursor: ZERO_CURSOR });

    const serverUid = generateGuid();
    const serverDelta = buildTaskAddDelta({ uid: serverUid, caption: "from MCP", createdDate: "2026-01-01T00:00:00", lastModified: "2026-01-01T00:00:00" });
    await handle.state.append("mcp", packEnvelope(serverDelta));
    const pulled = await client.pull(ZERO_CURSOR);
    expect(pulled.cursor).toBe(1n);
    const tasks = findSection(pulled.sections!, "TodoItems")!;
    expect(tasks.rows[0]?.[tasks.header.indexOf("UID")]).toBe(serverUid);

    const appUid = generateGuid();
    const appDelta = buildTaskAddDelta({ uid: appUid, caption: "from app", createdDate: "2026-01-01T00:00:01", lastModified: "2026-01-01T00:00:01" });
    const pushedCursor = await client.push(packEnvelope(appDelta), pulled.cursor);
    expect(pushedCursor).toBe(2n);
    expect(await client.pull(pulled.cursor)).toEqual({ cursor: pushedCursor });
    expect(await client.status()).toEqual({ cursor: "2", entries: { mcp: 1, app: 1 }, pendingForApp: 0 });
    await expect(client.finalize()).resolves.toBeUndefined();
  });
});

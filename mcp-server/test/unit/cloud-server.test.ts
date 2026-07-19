import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { buildTaskAddDelta } from "../../src/cloud/delta.js";
import { packEnvelope, unpackEnvelope } from "../../src/cloud/envelope.js";

const handles: CloudServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function post(handle: CloudServerHandle, route: string, body: unknown) {
  const response = await fetch(`http://${handle.host}:${handle.port}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("cloud HTTP server", () => {
  it("implements pull, push validation, filtering, and cursor rules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-server-")); dirs.push(dir);
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateDir: dir }); handles.push(handle);
    expect(await post(handle, "/v1/pull", { client: "mlo-app", cursor: "0" })).toEqual({ status: 200, body: { cursor: "0" } });

    const delta = packEnvelope(buildTaskAddDelta({ uid: "{12345678-1234-1234-1234-123456789ABC}", caption: "queued", createdDate: "a", lastModified: "a" }));
    await handle.state.append("mcp", delta);
    const pulled = await post(handle, "/v1/pull", { client: "mlo-app", cursor: "0" });
    expect(pulled.status).toBe(200);
    expect(pulled.body.cursor).toBe("1");
    expect(unpackEnvelope(Buffer.from(pulled.body.envelope as string, "base64"))).toBeTruthy();

    const pushed = await post(handle, "/v1/push", { client: "mlo-app", baseline: "1", envelope: Buffer.from(delta).toString("base64") });
    expect(pushed).toEqual({ status: 200, body: { cursor: "2" } });
    expect(await post(handle, "/v1/pull", { client: "mlo-app", cursor: "1" })).toEqual({ status: 200, body: { cursor: "2" } });
    expect((await post(handle, "/v1/push", { client: "mlo-app", baseline: "3", envelope: Buffer.from(delta).toString("base64") })).status).toBe(409);

    const before = await handle.state.highWater();
    expect((await post(handle, "/v1/push", { client: "mlo-app", baseline: "2", envelope: Buffer.from("garbage").toString("base64") })).status).toBe(400);
    expect(await handle.state.highWater()).toBe(before);

    // The app pulled through cursor 2, so nothing is pending for it.
    const status = await fetch(`http://${handle.host}:${handle.port}/v1/status`);
    expect(await status.json()).toEqual({ cursor: "2", entries: { mcp: 1, app: 1 }, pendingForApp: 0 });
  });
});

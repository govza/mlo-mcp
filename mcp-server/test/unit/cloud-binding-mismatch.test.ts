import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTaskAddDelta, mergeDeltas } from "../../src/cloud/delta.js";
import { packEnvelope } from "../../src/cloud/envelope.js";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { ResidentEndpoint } from "../../src/cloud/endpoint.js";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { addTaskTool } from "../../src/tools/add-task.js";
import { cloudBootstrapTool } from "../../src/tools/cloud-bootstrap.js";
import { cloudStatusTool } from "../../src/tools/cloud-status.js";
import { requireWriteChannel, resolveReadCloudState, type ToolContext } from "../../src/tools/shared.js";
import { SERVER_INFO } from "../../src/version.js";
import type { MloConfig } from "../../src/types.js";

/**
 * The binding-mismatch fault, driven at the only seam that reproduces it: a
 * real server instance receiving MLO's SOAP sync for an unbound `dataFileUID`,
 * observed through the public tool surface. Nothing here asserts on state
 * files, log lines, or which internal method decided the authority.
 */

const PROFILE = "C:\\Profiles\\Personal.ml";
const UID_A = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const UID_B = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";

const handles: CloudServerHandle[] = [];
const dirs: string[] = [];
const vendors: Vendor[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(vendors.splice(0).map((vendor) => vendor.close()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

interface Vendor {
  port: number;
  requests: string[];
  close(): Promise<void>;
}

function vendorResponse(dataBase64?: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<GetModificationsBytesExResponse xmlns="http://www.mylifeorganized.net/">` +
    `<GetModificationsBytesExResult>true</GetModificationsBytesExResult><maxVersion>7</maxVersion>` +
    (dataBase64 ? `<data>${dataBase64}</data>` : "") +
    `</GetModificationsBytesExResponse></soap:Body></soap:Envelope>`
  );
}

/** The vendor's complete history, as a client pull from version 0 receives it. */
function fullHistoryBase64(): string {
  const document = mergeDeltas([
    buildTaskAddDelta({
      uid: "{11111111-1111-1111-1111-111111111111}",
      caption: "Existing project",
      createdDate: "2026-07-01T08:00:00",
      lastModified: "2026-07-01T08:00:00",
    }),
  ]);
  return Buffer.from(packEnvelope(document)).toString("base64");
}

/** Stands in for the vendor cloud so the forward-to-vendor branch is real. */
async function startVendor(dataBase64?: string): Promise<Vendor> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
      response.end(vendorResponse(dataBase64));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const vendor: Vendor = {
    port: (server.address() as net.AddressInfo).port,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  vendors.push(vendor);
  return vendor;
}

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-drift-"));
  dirs.push(dir);
  return dir;
}

function contextFor(gateway: CloudGateway, extra?: Partial<ToolContext>): ToolContext {
  return {
    config: { dataFile: PROFILE, cloudHost: "127.0.0.1", cloudPort: 0 } as MloConfig,
    store: undefined as never,
    cloudState: gateway.defaultState(),
    cloud: gateway,
    ...extra,
  };
}

/** How an MCP session sees the endpoint: over loopback, never in-process. */
function attachedTo(handle: CloudServerHandle): ResidentEndpoint {
  return new ResidentEndpoint(handle.host, handle.port);
}

function syncRequestXml(uid: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<GetModificationsBytesEx xmlns="http://www.mylifeorganized.net/">` +
    `<loginBytes>bG9naW4=</loginBytes><passwordBytes>c2VjcmV0</passwordBytes>` +
    `<dataFileUID>${uid}</dataFileUID><newerThan>0</newerThan>` +
    `</GetModificationsBytesEx></soap:Body></soap:Envelope>`
  );
}

/** One MLO sync operation, exactly as the app sends it through the proxy. */
async function syncAs(handle: CloudServerHandle, vendor: Vendor, uid: string): Promise<number> {
  const body = syncRequestXml(uid);
  return new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        host: handle.host,
        port: handle.port,
        method: "POST",
        path: `http://127.0.0.1:${vendor.port}/mlo/MLOInetSync.asmx`,
        headers: {
          "content-type": "text/xml; charset=utf-8",
          soapaction: '"http://www.mylifeorganized.net/GetModificationsBytesEx"',
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function status(ctx: ToolContext): Promise<Record<string, unknown>> {
  const result = await cloudStatusTool.execute({}, ctx);
  return result.structuredContent as Record<string, unknown>;
}

/** What an agent asking for a write actually gets back. */
async function writeRefusal(ctx: ToolContext, caption = "written during a mismatch"): Promise<string> {
  const result = await addTaskTool.execute({ caption }, ctx).then(
    () => undefined,
    (error: Error) => error.message,
  );
  if (result === undefined) throw new Error("expected the write to be refused");
  return result;
}

/**
 * The state-root file holding a refused write's text, located by its contents
 * rather than by name: what a caller can act on is the path the refusal names,
 * not where the server chose to put it.
 */
async function preserved(stateRoot: string, needle: string): Promise<{ file: string; text: string }> {
  for (const entry of await fs.readdir(stateRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(stateRoot, entry.name);
    const text = await fs.readFile(file, "utf8");
    if (text.includes(needle)) return { file, text };
  }
  throw new Error(`nothing under ${stateRoot} preserved "${needle}"`);
}

async function anyFileMentions(stateRoot: string, needle: string): Promise<boolean> {
  return preserved(stateRoot, needle).then(
    () => true,
    () => false,
  );
}

/** A bound, ready upstream profile plus a running endpoint — the healthy state. */
async function boundProfile(dataBase64?: string): Promise<{ gateway: CloudGateway; handle: CloudServerHandle; vendor: Vendor }> {
  const gateway = new CloudGateway({ stateRoot: await root() });
  await gateway.bindings.create(PROFILE, "upstream");
  await gateway.bindings.bindUid(PROFILE, UID_A);
  await (await gateway.registry.open(UID_A, "upstream")).setLifecycle("ready");
  const vendor = await startVendor(dataBase64);
  const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
  handles.push(handle);
  return { gateway, handle, vendor };
}

describe("binding mismatch: the app syncs a dataFileUID the server does not manage", () => {
  it("surfaces the observed UID in cloud_status and refuses writes into the abandoned partition", async () => {
    const { gateway, handle, vendor } = await boundProfile();
    const ctx = contextFor(gateway);

    expect(await syncAs(handle, vendor, UID_B)).toBe(200);

    // Routing is untouched: the unknown profile still reaches the vendor.
    expect(vendor.requests).toEqual([syncRequestXml(UID_B)]);

    const reported = await status(ctx);
    expect(reported).toMatchObject({ dataFileUID: UID_A, bindingMismatch: true });
    expect(reported.unboundSightings).toMatchObject([{ dataFileUID: UID_B, count: 1 }]);

    // The write tool itself refuses, naming both UIDs, the profile, and the remedy.
    const refusal = await writeRefusal(ctx);
    expect(refusal).toMatch(/binding mismatch/i);
    expect(refusal).toContain(UID_A);
    expect(refusal).toContain(UID_B);
    expect(refusal).toContain(PROFILE);
    expect(refusal).toMatch(/rebind/);

    // Nothing was queued into the partition the app abandoned.
    const partition = await gateway.registry.open(UID_A, "upstream");
    expect(await partition.mirrorState.counts()).toEqual({ mcp: 0, app: 0 });
    expect(await partition.state.highWater()).toBe(0n);

    // Reads keep working while the binding is sorted out.
    expect(await resolveReadCloudState(ctx)).toBe(partition.mirrorState);
  });

  it("stays silent for a foreign profile when this profile has no binding of its own", async () => {
    const gateway = new CloudGateway({ stateRoot: await root() });
    const vendor = await startVendor();
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
    handles.push(handle);
    const ctx = contextFor(gateway);

    expect(await syncAs(handle, vendor, UID_B)).toBe(200);

    expect(await status(ctx)).toMatchObject({ mode: "unbound", bindingMismatch: false });
    // First-run setup and a mismatch must not share one message.
    const refusal = await writeRefusal(ctx);
    expect(refusal).toMatch(/no bootstrapped cloud partition/);
    expect(refusal).not.toMatch(/binding mismatch/i);
  });

  it("refuses a local-mode profile the same way when it has synced against the vendor", async () => {
    const gateway = new CloudGateway({ stateRoot: await root() });
    await gateway.bindings.create(PROFILE, "local");
    await gateway.bindings.bindUid(PROFILE, UID_A);
    await (await gateway.registry.open(UID_A, "local")).setLifecycle("ready");
    const vendor = await startVendor();
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
    handles.push(handle);
    const ctx = contextFor(gateway);

    // A local-mode profile that reached the vendor left the local authority —
    // it is exactly the drift the local bootstrap script warns can't be undone.
    await syncAs(handle, vendor, UID_B);

    expect(await status(ctx)).toMatchObject({ mode: "local", bindingMismatch: true });
    expect(await writeRefusal(ctx)).toMatch(/binding mismatch/i);
    expect(await (await gateway.registry.open(UID_A, "local")).state.highWater()).toBe(0n);
  });

  it("keeps reporting the mismatch after a restart and from a process without the listener", async () => {
    const { gateway, handle, vendor } = await boundProfile();
    await syncAs(handle, vendor, UID_B);
    const endpoint = attachedTo(handle);
    await handles.splice(handles.indexOf(handle), 1)[0]!.stop();

    // A fresh gateway over the same state root is what an attached MCP client
    // (or the next server run) sees: no listener, no in-memory contacts. The
    // mismatch is persisted, so it survives the endpoint going away entirely.
    const attached = new CloudGateway({ stateRoot: gateway.stateRoot });
    const ctx = contextFor(attached, { endpoint });
    expect(await status(ctx)).toMatchObject({
      dataFileUID: UID_A,
      bindingMismatch: true,
      endpoint: { reachable: false },
    });
    expect(await writeRefusal(ctx)).toMatch(/binding mismatch/i);
  });

  it("clears once the binding names the UID the app is actually syncing", async () => {
    const { gateway, handle, vendor } = await boundProfile();
    const ctx = contextFor(gateway);
    await syncAs(handle, vendor, UID_B);
    expect(await status(ctx)).toMatchObject({ bindingMismatch: true });

    await gateway.bindings.unbindUid(PROFILE);
    await gateway.bindings.bindUid(PROFILE, UID_B);

    const reported = await status(ctx);
    expect(reported).toMatchObject({ dataFileUID: UID_B, bindingMismatch: false });
    expect(reported.unboundSightings).toBeUndefined();
  });

  it("keeps refusing however long the app stays away, since nothing expires on a timer", async () => {
    const { gateway, handle, vendor } = await boundProfile();
    const ctx = contextFor(gateway);
    await syncAs(handle, vendor, UID_B);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(await status(ctx)).toMatchObject({ bindingMismatch: true });
    expect(await writeRefusal(ctx)).toMatch(/binding mismatch/i);
  });

  it("reports whether the resident endpoint is reachable, and at what build", async () => {
    const { gateway, handle } = await boundProfile();
    const ctx = contextFor(gateway, { endpoint: attachedTo(handle) });

    expect(await status(ctx)).toMatchObject({
      endpoint: { url: `http://${handle.host}:${handle.port}`, reachable: true, version: SERVER_INFO.version },
    });

    // "Is this working" stays one call after the endpoint goes away, which is
    // the state the old owner/attached role could not describe at all.
    await handles.splice(handles.indexOf(handle), 1)[0]!.stop();
    const down = await status(ctx);
    expect(down).toMatchObject({ endpoint: { reachable: false } });
    expect((down.endpoint as { version?: string }).version).toBeUndefined();
  });
});

/**
 * A refusal is loud and queues nothing, which is right for an agent that will
 * handle the error — and wrong for a capture, where the premise is that the
 * user has already moved on and will never read the panel it lands in. The
 * task is always re-addable; the sentence they typed is not.
 */
describe("a refused write leaves its words on disk", () => {
  it("preserves the text and names the file, without claiming the write landed", async () => {
    const { gateway, handle, vendor } = await boundProfile();
    const ctx = contextFor(gateway);
    await syncAs(handle, vendor, UID_B);

    const refusal = await writeRefusal(ctx, "look into the retry thing");

    const { file, text } = await preserved(gateway.stateRoot, "look into the retry thing");
    // A path the user can open beats a reassurance they cannot act on.
    expect(refusal).toContain(file);
    // The reason and a timestamp sit beside the words, so a recovered capture
    // says which fault dropped it and when.
    expect(text).toMatch(/binding mismatch/i);
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    // The file is a consolation, not an outcome: still a refusal, still nothing queued.
    const partition = await gateway.registry.open(UID_A, "upstream");
    expect(await partition.mirrorState.counts()).toEqual({ mcp: 0, app: 0 });
  });

  it("records the fault, so a first-run refusal is distinguishable from a mismatch", async () => {
    const gateway = new CloudGateway({ stateRoot: await root() });
    await gateway.ensureRoot();
    const ctx = contextFor(gateway);

    await writeRefusal(ctx, "capture before bootstrap");

    const { text } = await preserved(gateway.stateRoot, "capture before bootstrap");
    expect(text).toMatch(/cloud_bootstrap/);
    expect(text).not.toMatch(/binding mismatch/i);
  });

  it("keeps every capture when several are refused at once", async () => {
    const { gateway, handle, vendor } = await boundProfile();
    const ctx = contextFor(gateway);
    await syncAs(handle, vendor, UID_B);

    const captures = [0, 1, 2, 3, 4].map((n) => `concurrent capture ${n}`);
    await Promise.all(captures.map((caption) => writeRefusal(ctx, caption)));

    // One capture must not be dropped because another was refused in the same
    // moment — losing the words is the exact failure this file prevents.
    for (const caption of captures) expect(await anyFileMentions(gateway.stateRoot, caption)).toBe(true);
  });

  it("stays bounded so a long-running fault cannot grow it without limit", async () => {
    const { gateway, handle, vendor } = await boundProfile();
    const ctx = contextFor(gateway);
    await syncAs(handle, vendor, UID_B);

    for (let attempt = 0; attempt < 60; attempt += 1) await writeRefusal(ctx, `capture ${attempt}`);

    expect(await anyFileMentions(gateway.stateRoot, "capture 59")).toBe(true);
    expect(await anyFileMentions(gateway.stateRoot, "capture 0\"")).toBe(false);
  });

  it("writes nothing when the write channel resolves", async () => {
    const gateway = new CloudGateway({ stateRoot: await root() });
    await gateway.bindings.create(PROFILE, "local");
    await gateway.bindings.bindUid(PROFILE, UID_A);
    await (await gateway.registry.open(UID_A, "local")).setLifecycle("ready");
    const ctx = contextFor(gateway);

    await requireWriteChannel(ctx, { tool: "add_task", content: "a write that was allowed" });

    expect(await anyFileMentions(gateway.stateRoot, "a write that was allowed")).toBe(false);
  });
});

describe("cloud_bootstrap preconditions are checked before the binding moves", () => {
  it("refuses when no endpoint is reachable to lend credentials, and changes nothing", async () => {
    const { gateway, handle } = await boundProfile();
    const endpoint = attachedTo(handle);
    await handles.splice(handles.indexOf(handle), 1)[0]!.stop();

    await expect(cloudBootstrapTool.execute({ rebind: true }, contextFor(gateway, { endpoint })))
      .rejects.toThrow(/not reachable/);
    expect((await gateway.bindings.forProfile(PROFILE))?.dataFileUID).toBe(UID_A);
  });

  it("leaves the binding intact when a rebind has no vendor contact to bootstrap from", async () => {
    const { gateway, handle } = await boundProfile();
    const ctx = contextFor(gateway, { endpoint: attachedTo(handle) });

    await expect(cloudBootstrapTool.execute({ rebind: true }, ctx)).rejects.toThrow(/no vendor sync traffic/);
    expect((await gateway.bindings.forProfile(PROFILE))?.dataFileUID).toBe(UID_A);
  });

  it("re-pulls the cloud file a profile is already bound to when asked to rebind", async () => {
    const { gateway, handle, vendor } = await boundProfile(fullHistoryBase64());
    // A separate gateway over the same state root is what an attached session
    // really has: no contacts of its own, so the pull can only come from the
    // endpoint. Nothing here would pass if the bootstrap read them locally.
    const session = new CloudGateway({ stateRoot: gateway.stateRoot });
    const ctx = contextFor(session, { endpoint: attachedTo(handle) });
    // The profile's own sync is what exposes the vendor contact.
    expect(await syncAs(handle, vendor, UID_A)).toBe(200);

    const result = await cloudBootstrapTool.execute({ rebind: true }, ctx);
    expect(result.structuredContent).toMatchObject({ bootstrapped: true, version: "7", tasks: 1 });
    expect((await session.bindings.forProfile(PROFILE))?.dataFileUID).toBe(UID_A);
    expect(await (await session.registry.open(UID_A, "upstream")).lifecycle()).toBe("ready");
  });
});

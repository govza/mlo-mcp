import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { ResidentEndpoint } from "../../src/cloud/endpoint.js";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { buildTaskAddDelta, mergeDeltas } from "../../src/cloud/delta.js";
import { packEnvelope } from "../../src/cloud/envelope.js";
import { emitSectionedCsv, findSection, type SectionedCsv } from "../../src/cloud/csv.js";
import { knownCloudProjection, rowValue } from "../../src/cloud/log-projection.js";
import { cloudBootstrapTool } from "../../src/tools/cloud-bootstrap.js";
import { requireWriteChannel, type ToolContext } from "../../src/tools/shared.js";
import type { MloConfig } from "../../src/types.js";

const dirs: string[] = [];
const handles: CloudServerHandle[] = [];
const vendors: http.Server[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(vendors.splice(0).map((vendor) => new Promise((resolve) => vendor.close(resolve))));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const PROFILE = "C:\\Profiles\\Personal.ml";
const UID = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const TASK_UID = "{11111111-1111-1111-1111-111111111111}";

function fullSnapshot(caption = "Existing task"): SectionedCsv {
  const document = mergeDeltas([
    buildTaskAddDelta({
      uid: TASK_UID,
      caption,
      createdDate: "2026-07-01T08:00:00",
      lastModified: "2026-07-01T08:00:00",
    }),
  ]);
  document.sections.push({ name: "Config", header: ["Name", "Value"], rows: [["SORT_TYPE", "1"]] });
  return document;
}

function soapEnvelope(operation: string, fields: Record<string, string>): string {
  const body = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation} xmlns="http://www.mylifeorganized.net/">${body}</${operation}>` +
    `</soap:Body></soap:Envelope>`;
}

function vendorResponse(operation: string, fields: Record<string, string>): string {
  const body = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation}Response xmlns="http://www.mylifeorganized.net/">${body}</${operation}Response>` +
    `</soap:Body></soap:Envelope>`;
}

interface VendorCall { operation: string; body: string }

/** A scripted fake vendor: answers per-operation and records what it saw. */
async function startVendor(script: (operation: string, body: string) => { status?: number; body: string }): Promise<{ port: number; calls: VendorCall[] }> {
  const calls: VendorCall[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const action = (request.headers.soapaction ?? "").toString();
      const operation = action.replace(/"/g, "").split("/").pop() ?? "";
      calls.push({ operation, body });
      const answer = script(operation, body);
      response.writeHead(answer.status ?? 200, { "content-type": "text/xml; charset=utf-8", "x-vendor": "fake" });
      response.end(answer.body);
    });
  });
  vendors.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, calls };
}

async function startProxy(gateway: CloudGateway): Promise<CloudServerHandle> {
  const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1" });
  handles.push(handle);
  return handle;
}

/** Absolute-form proxied POST, the shape MLO's proxy setting produces. */
function proxied(handle: CloudServerHandle, vendorPort: number, operation: string, body: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: handle.host,
      port: handle.port,
      method: "POST",
      path: `http://127.0.0.1:${vendorPort}/mlo/MLOInetSync.asmx`,
      headers: {
        "content-type": "text/xml; charset=utf-8",
        soapaction: `"http://www.mylifeorganized.net/${operation}"`,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode!,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function upstreamGateway(): Promise<CloudGateway> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-up-"));
  dirs.push(root);
  const gateway = new CloudGateway({ stateRoot: root });
  await gateway.ensureRoot();
  return gateway;
}

function contextFor(gateway: CloudGateway): ToolContext {
  return {
    config: { dataFile: PROFILE } as MloConfig,
    store: undefined as never,
    cloudState: gateway.defaultState(),
    cloud: gateway,
  };
}

describe("upstream transparent proxy", () => {
  it("forwards all three operations verbatim and returns the vendor response unchanged", async () => {
    const gateway = await upstreamGateway();
    await gateway.bindings.create(PROFILE, "upstream");
    await gateway.bindings.bindUid(PROFILE, UID);
    const vendor = await startVendor((operation) => ({
      body: operation === "GetModificationsBytesEx"
        ? vendorResponse(operation, { GetModificationsBytesExResult: "true", maxVersion: "15515" })
        : operation === "ApplyModificationsBytesEx"
          ? vendorResponse(operation, { ApplyModificationsBytesExResult: "true", newServerTimeStamp: "15516" })
          : vendorResponse(operation, { ReleaseSyncSessionBytesResult: "true" }),
    }));
    const proxy = await startProxy(gateway);

    const get = await proxied(proxy, vendor.port, "GetModificationsBytesEx",
      soapEnvelope("GetModificationsBytesEx", { sessionID: "s1", dataFileUID: UID, newerThan: "15514" }));
    expect(get.status).toBe(200);
    expect(get.headers["x-vendor"]).toBe("fake"); // vendor headers pass through
    expect(get.body).toContain("<maxVersion>15515</maxVersion>");

    const apply = await proxied(proxy, vendor.port, "ApplyModificationsBytesEx",
      soapEnvelope("ApplyModificationsBytesEx", { sessionID: "s1", dataFileUID: UID, lastSyncTimestamp: "24838", data: "" }));
    expect(apply.body).toContain("<newServerTimeStamp>15516</newServerTimeStamp>");

    const release = await proxied(proxy, vendor.port, "ReleaseSyncSessionBytes",
      soapEnvelope("ReleaseSyncSessionBytes", { sessionID: "s1", dataFileUID: UID }));
    expect(release.body).toContain("<ReleaseSyncSessionBytesResult>true</ReleaseSyncSessionBytesResult>");

    // The vendor saw the requests byte-for-byte.
    expect(vendor.calls.map((call) => call.operation)).toEqual([
      "GetModificationsBytesEx", "ApplyModificationsBytesEx", "ReleaseSyncSessionBytes",
    ]);
    expect(vendor.calls[0]!.body).toContain("<newerThan>15514</newerThan>");
    expect(vendor.calls[1]!.body).toContain("<lastSyncTimestamp>24838</lastSyncTimestamp>");
    // Nothing was locally cursor-stamped: the local log for this partition stays empty.
    const partition = await gateway.registry.open(UID);
    expect(await partition.state.highWater()).toBe(0n);
  });


  it("returns the vendor response unchanged even when mirror capture fails", async () => {
    const gateway = await upstreamGateway();
    await gateway.bindings.create(PROFILE, "upstream");
    await gateway.bindings.bindUid(PROFILE, UID);
    const vendor = await startVendor((operation) => ({
      body: vendorResponse(operation, {
        [`${operation}Result`]: "true",
        newServerTimeStamp: "200",
      }),
    }));
    const proxy = await startProxy(gateway);
    // "not-a-zip" is accepted by the fake vendor but cannot be captured.
    const apply = await proxied(proxy, vendor.port, "ApplyModificationsBytesEx",
      soapEnvelope("ApplyModificationsBytesEx", {
        sessionID: "s1", dataFileUID: UID, lastSyncTimestamp: "0",
        data: Buffer.from("not a zip").toString("base64"),
      }));
    expect(apply.status).toBe(200);
    expect(apply.body).toContain("<newServerTimeStamp>200</newServerTimeStamp>");
    expect(await gateway.mirrorHealthy()).toBe(false);
    const partition = await gateway.registry.open(UID);
    expect(await partition.mirrorState.highWater()).toBe(0n);
  });

  it("pins the authority per session so a mid-session binding change cannot switch it", async () => {
    const gateway = await upstreamGateway();
    await gateway.bindings.create(PROFILE, "upstream");
    await gateway.bindings.bindUid(PROFILE, UID);
    const vendor = await startVendor((operation) => ({
      body: vendorResponse(operation, { [`${operation}Result`]: "true", maxVersion: "1" }),
    }));
    const proxy = await startProxy(gateway);
    await proxied(proxy, vendor.port, "GetModificationsBytesEx",
      soapEnvelope("GetModificationsBytesEx", { sessionID: "pinned", dataFileUID: UID, newerThan: "0" }));
    expect(vendor.calls).toHaveLength(1);

    // Simulate an operator rebinding the profile to local mid-session.
    await gateway.bindings.unbindUid(PROFILE);
    // (a fresh local-mode binding for the same UID would normally be a new
    // profile epoch; here we just verify the pin keeps routing upstream)
    const followUp = await proxied(proxy, vendor.port, "ReleaseSyncSessionBytes",
      soapEnvelope("ReleaseSyncSessionBytes", { sessionID: "pinned", dataFileUID: UID }));
    expect(followUp.status).toBe(200);
    expect(vendor.calls).toHaveLength(2); // still forwarded to the vendor
  });

  it("flags the mirror as blind when the vendor sync host is reached via CONNECT", async () => {
    const gateway = await upstreamGateway();
    const proxy = await startProxy(gateway);
    expect(await gateway.mirrorBlind()).toBe(false);
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(proxy.port, proxy.host, () => {
        socket.write("CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n");
      });
      socket.on("data", () => { socket.destroy(); resolve(); });
      socket.on("error", reject);
    });
    // Poll briefly — the flag write is fire-and-forget.
    for (let attempt = 0; attempt < 50 && !(await gateway.mirrorBlind()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await gateway.mirrorBlind()).toBe(true);
  });

  it("keeps an upstream mirror and a local partition with identical content fully separate", async () => {
    const gateway = await upstreamGateway();
    // Profile A: upstream-bound mirror.
    await gateway.bindings.create(PROFILE, "upstream");
    await gateway.bindings.bindUid(PROFILE, UID);
    const upstream = await gateway.registry.open(UID);
    await upstream.mirrorState.appendAtCursor("app", packEnvelope(fullSnapshot("mirror copy")), 50n as never);
    // Profile B: local-mode partition holding the IDENTICAL task UID/caption.
    const LOCAL_UID = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
    await gateway.bindings.create("C:\\local.ml", "local");
    await gateway.bindings.bindUid("C:\\local.ml", LOCAL_UID);
    const local = await gateway.registry.open(LOCAL_UID);
    await local.state.append("mcp", packEnvelope(fullSnapshot("local copy")));

    const mirrorProjection = await knownCloudProjection(upstream.mirrorState);
    const localProjection = await knownCloudProjection(local.state);
    expect(rowValue(mirrorProjection.rows.get(TASK_UID)!, "Caption")).toBe("mirror copy");
    expect(rowValue(localProjection.rows.get(TASK_UID)!, "Caption")).toBe("local copy");
    // Their cursor namespaces are independent too.
    expect(await upstream.mirrorState.highWater()).toBe(50n);
    expect(await local.state.highWater()).toBe(1n);
  });
});

/**
 * The resident model, driven the way it actually runs: the endpoint holds the
 * vendor contact, and the MCP session is a DIFFERENT gateway over the same
 * state root with an empty contact map. Every assertion here would pass
 * trivially if the session could still reach the credentials itself, so the
 * separate gateway is the point of the fixture, not an incidental detail.
 */
describe("writes and bootstrap forwarded through the resident endpoint", () => {
  const NEW_TASK = "{22222222-2222-2222-2222-222222222222}";

  /**
   * A pull from vendor version 0 returns the service's database-shaped full
   * projection, not the ZIP/delta shape used for ordinary Get responses.
   * Stable cloud columns are all present, but database-only columns are mixed
   * in, Hotkey is absent, and empty tombstone sections may be omitted.
   */
  function rawVendorHistory(): Uint8Array {
    const document = fullSnapshot();
    const places = findSection(document, "Places")!;
    const placeHeader = places.header;
    places.header = ["PlaceID", ...placeHeader.filter((column) => column !== "Hotkey"), "Timestamp"];
    places.rows = places.rows.map((row) => [
      "",
      ...row.filter((_, index) => placeHeader[index] !== "Hotkey"),
      "",
    ]);

    const flags = findSection(document, "Flags")!;
    flags.header = ["FlagID", ...flags.header, "Timestamp"];
    flags.rows = flags.rows.map((row) => ["", ...row, ""]);

    const tasks = findSection(document, "TodoItems")!;
    tasks.header = ["TodoItemID", "ParentItemID", "IsComplete", ...tasks.header, "Timestamp", "FlagID"];
    tasks.rows = tasks.rows.map((row) => ["", "", "", ...row, "", ""]);
    document.sections = document.sections.filter(
      (section) => section.name !== "Places.Deleted" && section.name !== "Flags.Deleted",
    );
    return emitSectionedCsv(document);
  }

  /** Answers a full history from 0, and assigns 501 to whatever is applied. */
  function scriptedVendor(history: Uint8Array = packEnvelope(fullSnapshot())) {
    return startVendor((operation, body) => {
      if (operation === "GetModificationsBytesEx") {
        const fromZero = body.includes("<newerThan>0</newerThan>");
        return {
          body: vendorResponse(operation, {
            GetModificationsBytesExResult: "true",
            maxVersion: "500",
            ...(fromZero ? { data: Buffer.from(history).toString("base64") } : {}),
          }),
        };
      }
      if (operation === "ApplyModificationsBytesEx") {
        return { body: vendorResponse(operation, { ApplyModificationsBytesExResult: "true", newServerTimeStamp: "501" }) };
      }
      return { body: vendorResponse(operation, { ReleaseSyncSessionBytesResult: "true" }) };
    });
  }

  /** An endpoint holding the contact, plus the session's own view of the root. */
  async function attachedSession(history?: Uint8Array): Promise<{
    resident: CloudGateway;
    session: CloudGateway;
    ctx: ToolContext;
    vendor: Awaited<ReturnType<typeof startVendor>>;
  }> {
    const resident = await upstreamGateway();
    await resident.bindings.create(PROFILE, "upstream");
    const vendor = await scriptedVendor(history);
    const proxy = await startProxy(resident);
    // One ordinary proxied sync is what exposes the contact — to the LISTENING
    // process's memory, and nowhere else.
    await proxied(proxy, vendor.port, "GetModificationsBytesEx", soapEnvelope("GetModificationsBytesEx", {
      loginBytes: "bG9naW4=", passwordBytes: "cGFzcw==", sessionID: "app-session",
      dataFileUID: UID, newerThan: "500",
    }));
    const session = new CloudGateway({ stateRoot: resident.stateRoot });
    expect(session.vendorContactUids()).toEqual([]);
    return {
      resident,
      session,
      vendor,
      ctx: { ...contextFor(session), endpoint: new ResidentEndpoint(proxy.host, proxy.port) },
    };
  }

  it("bootstraps and commits as one more vendor client, with the credentials never leaving the endpoint", async () => {
    const { session, ctx, vendor } = await attachedSession();

    const bootstrapped = await cloudBootstrapTool.execute({}, ctx);
    expect(bootstrapped.structuredContent).toMatchObject({ bootstrapped: true, version: "500" });
    const partition = await session.registry.open(UID);
    expect(await partition.lifecycle()).toBe("ready");
    expect(await partition.mirrorState.highWater()).toBe(500n);

    // Refresh, author, commit — the two round trips that straddle the process
    // boundary, resolved against the mirror the session reads off disk.
    const channel = await requireWriteChannel(ctx, { tool: "add_tasks", content: "written by MCP" });
    expect(channel.state).toBe(partition.mirrorState);
    const version = await channel.commit(packEnvelope(mergeDeltas([
      buildTaskAddDelta({ uid: NEW_TASK, caption: "written by MCP", createdDate: "2026-07-23T10:00:00", lastModified: "2026-07-23T10:00:00" }),
    ])));
    expect(version).toBe("501");
    expect(await partition.mirrorState.highWater()).toBe(501n);

    // The vendor saw a real client session: credentials, session id, opaque
    // zero stamp, and the envelope; then a release.
    const apply = vendor.calls.find((call) => call.operation === "ApplyModificationsBytesEx")!;
    expect(apply.body).toContain("<loginBytes>bG9naW4=</loginBytes>");
    expect(apply.body).toContain("<lastSyncTimestamp>0</lastSyncTimestamp>");
    expect(apply.body).toContain(`<dataFileUID>${UID}</dataFileUID>`);
    expect(vendor.calls.at(-1)!.operation).toBe("ReleaseSyncSessionBytes");

    // The write is visible to projections immediately (and to MLO on its next
    // QuickSync through the proxy).
    const projection = await knownCloudProjection(channel.state);
    expect(rowValue(projection.rows.get(NEW_TASK)!, "Caption")).toBe("written by MCP");
    expect(rowValue(projection.rows.get(TASK_UID)!, "Caption")).toBe("Existing task");
  });

  it("normalizes the vendor's raw full-history projection before bootstrapping", async () => {
    const { session, ctx } = await attachedSession(rawVendorHistory());

    const bootstrapped = await cloudBootstrapTool.execute({}, ctx);
    expect(bootstrapped.structuredContent).toMatchObject({
      bootstrapped: true,
      version: "500",
      tasks: 1,
    });
    const partition = await session.registry.open(UID);
    expect(await partition.lifecycle()).toBe("ready");

    const projection = await knownCloudProjection(partition.mirrorState);
    expect(rowValue(projection.rows.get(TASK_UID)!, "Caption")).toBe("Existing task");
  });

  it("refuses the commit when the cloud file moved while the write was being authored", async () => {
    const { session, ctx, vendor } = await attachedSession();
    await cloudBootstrapTool.execute({}, ctx);
    const partition = await session.registry.open(UID);

    const channel = await requireWriteChannel(ctx, { tool: "add_tasks", content: "authored against version 500" });
    // A mobile edit lands through MLO's own sync while the author is still
    // reading rows. The rows this write carries are now superseded.
    await partition.mirrorState.appendAtCursor("app", packEnvelope(fullSnapshot("changed on mobile")), 505n as never);

    const applies = vendor.calls.filter((call) => call.operation === "ApplyModificationsBytesEx").length;
    await expect(channel.commit(packEnvelope(mergeDeltas([
      buildTaskAddDelta({ uid: NEW_TASK, caption: "written by MCP", createdDate: "2026-07-23T10:00:00", lastModified: "2026-07-23T10:00:00" }),
    ])))).rejects.toThrow(/moved from version 500 to 505.*retry/s);

    // Nothing was uploaded, and the mirror still ends at the mobile edit.
    expect(vendor.calls.filter((call) => call.operation === "ApplyModificationsBytesEx")).toHaveLength(applies);
    expect(await partition.mirrorState.highWater()).toBe(505n);
  });

  it("commits a local-mode write from an attached session with no contact involved", async () => {
    const resident = await upstreamGateway();
    const proxy = await startProxy(resident);
    const LOCAL_PROFILE = "C:\\Profiles\\Scratch.ml";
    const LOCAL_UID = "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}";
    await resident.bindings.create(LOCAL_PROFILE, "local");
    await resident.bindings.bindUid(LOCAL_PROFILE, LOCAL_UID);
    await (await resident.registry.open(LOCAL_UID, "local")).setLifecycle("ready");

    const session = new CloudGateway({ stateRoot: resident.stateRoot });
    const ctx: ToolContext = {
      ...contextFor(session),
      config: { dataFile: LOCAL_PROFILE } as MloConfig,
      endpoint: new ResidentEndpoint(proxy.host, proxy.port),
    };

    const channel = await requireWriteChannel(ctx, { tool: "add_task", content: "local write" });
    const cursor = await channel.commit(packEnvelope(mergeDeltas([
      buildTaskAddDelta({ uid: NEW_TASK, caption: "local write", createdDate: "2026-07-23T10:00:00", lastModified: "2026-07-23T10:00:00" }),
    ])));

    // Queued straight into the replacement log: no vendor session, no contact.
    expect(cursor).toBe("1");
    expect(await (await session.registry.open(LOCAL_UID, "local")).state.highWater()).toBe(1n);
  });
});

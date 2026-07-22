import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { normalizeDataFileUid, partitionKey, PartitionRegistry } from "../../src/cloud/partition.js";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { handleSoapRequest } from "../../src/cloud/soap.js";
import { buildTaskAddDelta } from "../../src/cloud/delta.js";
import { packEnvelope, unpackEnvelope } from "../../src/cloud/envelope.js";
import { findSection } from "../../src/cloud/csv.js";

const dirs: string[] = [];
const handles: CloudServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const UID_A = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const UID_B = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
/** The same task identity in both partitions — isolation must keep them apart. */
const TASK_UID = "{12345678-1234-1234-1234-123456789ABC}";

function taskDelta(caption: string): Uint8Array {
  return packEnvelope(buildTaskAddDelta({
    uid: TASK_UID,
    caption,
    createdDate: "2026-07-19T12:00:00",
    lastModified: "2026-07-19T12:00:00",
  }));
}

function soapRequest(operation: string, fields: Record<string, string>): string {
  const xml = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${operation} xmlns="http://www.mylifeorganized.net/">${xml}</${operation}>` +
    `</soap:Body></soap:Envelope>`;
}

function responseField(bytes: Uint8Array, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(Buffer.from(bytes).toString("utf8"));
  return match?.[1];
}

describe("dataFileUID normalization and partition keys", () => {
  it("normalizes braces and case, and rejects non-GUID input", () => {
    expect(normalizeDataFileUid("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
      .toBe("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}");
    expect(normalizeDataFileUid("{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}"))
      .toBe("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}");
    expect(() => normalizeDataFileUid("not-a-guid")).toThrow("invalid dataFileUID");
    expect(() => normalizeDataFileUid("")).toThrow("invalid dataFileUID");
    expect(() => normalizeDataFileUid("../../escape")).toThrow("invalid dataFileUID");
  });

  it("derives equal hashed keys for equivalent spellings and never uses the raw GUID", () => {
    const key = partitionKey("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(key).toBe(partitionKey("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"));
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).not.toContain("AAAAAAAA");
  });
});

describe("partition registry", () => {
  it("creates partitions with meta and resolves existing ones only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-root-")); dirs.push(root);
    const registry = new PartitionRegistry(root, "local");
    expect(await registry.resolveExisting(UID_A)).toBeUndefined();
    const partition = await registry.open(UID_A);
    expect(partition.uid).toBe(UID_A);
    expect(await partition.lifecycle()).toBe("uninitialized");
    expect(await partition.mode()).toBe("local");
    expect(await partition.isEmpty()).toBe(true);
    expect(await registry.resolveExisting(UID_A)).toBe(partition);
    const listed = await registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.dataFileUID).toBe(UID_A);
  });

  it("keeps two partitions holding identical task UIDs and captions fully isolated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-root-")); dirs.push(root);
    const registry = new PartitionRegistry(root, "local");
    const a = await registry.open(UID_A);
    const b = await registry.open(UID_B);
    expect(a.dir).not.toBe(b.dir);

    await a.state.append("app", taskDelta("caption in A"));
    expect(await a.isEmpty()).toBe(false);
    expect(await b.isEmpty()).toBe(true);
    expect(await b.state.highWater()).toBe(0n);

    await b.state.append("app", taskDelta("caption in B"));
    const fromA = await a.state.entriesAfter(0n as never);
    const fromB = await b.state.entriesAfter(0n as never);
    const captionOf = (bytes: Uint8Array) => {
      const tasks = findSection(unpackEnvelope(bytes), "TodoItems")!;
      return tasks.rows[0]?.[tasks.header.indexOf("Caption")];
    };
    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
    expect(captionOf(fromA[0]!.bytes)).toBe("caption in A");
    expect(captionOf(fromB[0]!.bytes)).toBe("caption in B");
  });
});

describe("SOAP partition routing", () => {
  it("routes sync operations by their dataFileUID and keeps histories apart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-root-")); dirs.push(root);
    const gateway = new CloudGateway({ stateRoot: root, defaultMode: "local" });

    const apply = async (uid: string, caption: string) => handleSoapRequest(gateway, "ApplyModificationsBytesEx", soapRequest("ApplyModificationsBytesEx", {
      dataFileUID: uid,
      lastSyncTimestamp: "0",
      data: Buffer.from(taskDelta(caption)).toString("base64"),
    }));
    expect(responseField(await apply(UID_A, "caption in A"), "newServerTimeStamp")).toBe("1");
    expect(responseField(await apply(UID_B, "caption in B"), "newServerTimeStamp")).toBe("1");

    // A pull from partition A must never see partition B's rows even though
    // both hold the identical task UID; entries are excluded by same-origin,
    // so pull as the "mcp" side via each partition's state directly.
    const registry = gateway.registry!;
    const a = await registry.open(UID_A);
    const entries = await a.state.entriesAfter(0n as never);
    expect(entries).toHaveLength(1);
    const tasks = findSection(unpackEnvelope(entries[0]!.bytes), "TodoItems")!;
    expect(tasks.rows[0]?.[tasks.header.indexOf("Caption")]).toBe("caption in A");
  });

  it("fails a sync operation without a dataFileUID in partitioned mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-root-")); dirs.push(root);
    const gateway = new CloudGateway({ stateRoot: root, defaultMode: "local" });
    const response = await handleSoapRequest(gateway, "GetModificationsBytesEx", soapRequest("GetModificationsBytesEx", {
      newerThan: "0",
    }));
    expect(responseField(response, "GetModificationsBytesExResult")).toBe("false");
    expect(responseField(response, "errorMessage")).toContain("dataFileUID is required");
  });
});

describe("/v1 partition addressing", () => {
  it("routes by dataFileUID in partitioned mode and stays isolated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-root-")); dirs.push(root);
    const gateway = new CloudGateway({ stateRoot: root, defaultMode: "local" });
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway }); handles.push(handle);
    const base = `http://${handle.host}:${handle.port}`;

    const push = async (uid: string, caption: string) => {
      const response = await fetch(`${base}/v1/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client: "test-client",
          dataFileUID: uid,
          baseline: "0",
          envelope: Buffer.from(taskDelta(caption)).toString("base64"),
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json() as { cursor: string }).cursor;
    };
    expect(await push(UID_A, "caption in A")).toBe("1");
    // Same starting cursor in B proves the cursor namespaces are independent.
    expect(await push(UID_B, "caption in B")).toBe("1");

    const pull = async (uid: string) => {
      const response = await fetch(`${base}/v1/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: "mlo-app", dataFileUID: uid, cursor: "0" }),
      });
      expect(response.status).toBe(200);
      const value = await response.json() as { cursor: string; envelope?: string };
      const tasks = findSection(unpackEnvelope(Buffer.from(value.envelope!, "base64")), "TodoItems")!;
      return tasks.rows[0]?.[tasks.header.indexOf("Caption")];
    };
    expect(await pull(UID_A)).toBe("caption in A");
    expect(await pull(UID_B)).toBe("caption in B");

    const status = await (await fetch(`${base}/v1/status`)).json() as Record<string, unknown>;
    expect(status.cursor).toBe("0"); // default (unbound) state is untouched
    expect(status.stateRoot).toBe(root);
    expect((status.partitions as unknown[]).length).toBe(2);
  });

  it("rejects an invalid dataFileUID without touching any state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-root-")); dirs.push(root);
    const gateway = new CloudGateway({ stateRoot: root, defaultMode: "local" });
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, gateway }); handles.push(handle);
    const response = await fetch(`http://${handle.host}:${handle.port}/v1/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "x", dataFileUID: "nope", cursor: "0" }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("invalid dataFileUID");
  });

  it("keeps the legacy single-log behavior when only a stateDir is configured", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-legacy-")); dirs.push(dir);
    const handle = await startCloudServer({ host: "127.0.0.1", port: 0, stateDir: dir }); handles.push(handle);
    const base = `http://${handle.host}:${handle.port}`;
    const response = await fetch(`${base}/v1/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: "test-client",
        baseline: "0",
        envelope: Buffer.from(taskDelta("legacy")).toString("base64"),
      }),
    });
    expect(response.status).toBe(200);
    const status = await (await fetch(`${base}/v1/status`)).json() as Record<string, unknown>;
    expect(status.cursor).toBe("1");
    expect(status.stateRoot).toBeUndefined();
    expect(status.partitions).toBeUndefined();
    // The delta landed in the legacy dir itself, not a partitions/ tree.
    expect(await fs.stat(path.join(dir, "delta-1.zip")).then(() => true, () => false)).toBe(true);
  });
});

import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { CloudGateway } from "../../src/cloud/gateway.js";
import { PartitionStore } from "../../src/cloud/partition.js";
import { buildTaskAddDelta, deltaRowsFromDocument } from "../../src/cloud/mlo-schema.js";
import { packEnvelope, unpackEnvelope } from "../../src/cloud/envelope.js";
import { harvestTaskRows } from "../../src/cloud/row-store.js";
import { peekSoapResponseFields, soapFieldText } from "../../src/cloud/soap.js";
import type { SectionedCsv } from "../../src/cloud/csv.js";
import type { DeltaRow } from "../../src/repo/mlo-repository.js";

/**
 * The non-interference invariant, executable (spec section 6, test strategy
 * section 8). The resident's whole handler stack runs in-process against a
 * canned vendor; each case breaks one subsystem and asserts the same thing:
 * MLO's proxied sync completes, carrying the vendor's payload. The only
 * failure MLO may ever observe is genuine vendor transport failure.
 *
 * Sabotage is applied to the live objects the stack holds, not to modules, so
 * a case can never pass because it broke something the forward path never
 * touched: every rig starts from a stack that DOES enrich (a write is queued),
 * and the assertion is what MLO received.
 */

const UID = "{5A5A5A5A-5A5A-5A5A-5A5A-5A5A5A5A5A5A}";
const PROFILE = "C:/profiles/sabotage.ml";
/** In the vendor's own Get payload — the bytes that must survive every case. */
const VENDOR_TASK = "{99999999-8888-7777-6666-555555555555}";
/** Queued through the write path, so a healthy stack has work to inject. */
const MCP_TASK = "{11111111-2222-3333-4444-555555555555}";

const handles: CloudServerHandle[] = [];
const dirs: string[] = [];
const vendors: http.Server[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(vendors.splice(0).map((vendor) =>
    new Promise<void>((resolve) => vendor.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function addRows(uid: string, caption: string): DeltaRow[] {
  return deltaRowsFromDocument(buildTaskAddDelta({
    uid,
    caption,
    createdDate: "2026-07-27T09:00:00",
    lastModified: "2026-07-27T09:00:00",
  }));
}

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    inner +
    `</soap:Body></soap:Envelope>`;
}

function soapResponse(operation: string, fields: string): string {
  return soapEnvelope(`<${operation}Response xmlns="http://www.mylifeorganized.net/">${fields}</${operation}Response>`);
}

function soapRequest(operation: string, fields: Record<string, string>): string {
  const xml = Object.entries(fields).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return soapEnvelope(`<${operation} xmlns="http://www.mylifeorganized.net/">${xml}</${operation}>`);
}

function base64Envelope(document: SectionedCsv): string {
  return Buffer.from(packEnvelope(document)).toString("base64");
}

const VENDOR_DELTA = buildTaskAddDelta({
  uid: VENDOR_TASK,
  caption: "the vendor's own row",
  createdDate: "2026-07-27T08:00:00",
  lastModified: "2026-07-27T08:00:00",
});

/** The canned vendor session: one healthy answer per operation. */
const VENDOR_ANSWERS: Record<string, string> = {
  GetModificationsBytesEx: soapResponse("GetModificationsBytesEx",
    `<GetModificationsBytesExResult>true</GetModificationsBytesExResult>` +
    `<maxVersion>100</maxVersion><data>${base64Envelope(VENDOR_DELTA)}</data>`),
  ApplyModificationsBytesEx: soapResponse("ApplyModificationsBytesEx",
    `<ApplyModificationsBytesExResult>true</ApplyModificationsBytesExResult>` +
    `<newServerTimeStamp>151</newServerTimeStamp>`),
  ReleaseSyncSessionBytes: soapResponse("ReleaseSyncSessionBytes",
    `<ReleaseSyncSessionBytesResult>true</ReleaseSyncSessionBytesResult>`),
  GetFileTS: soapResponse("GetFileTS", `<GetFileTSResult>147</GetFileTSResult>`),
};

function operationOf(soapAction: string | undefined): string {
  const match = /([A-Za-z]+)"?$/.exec(soapAction ?? "");
  return match?.[1] ?? "";
}

interface Answer {
  status: number;
  body: string;
}

interface Rig {
  root: string;
  gateway: CloudGateway;
  handle: CloudServerHandle;
  partition: PartitionStore;
  /** Where the proxied requests are addressed; a dead port for the transport-failure case. */
  vendorPort: number;
}

async function startVendor(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((request, response) => {
    const body = VENDOR_ANSWERS[operationOf(request.headers.soapaction as string | undefined)];
    request.resume();
    request.on("end", () => {
      if (!body) {
        response.writeHead(500, { "content-type": "text/xml; charset=utf-8" });
        response.end("<unexpected-operation/>");
        return;
      }
      response.writeHead(200, { "content-type": "text/xml; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
  });
  vendors.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing vendor address");
  return { server, port: address.port };
}

/** A port nothing listens on: what genuine vendor transport failure looks like. */
async function deadPort(): Promise<number> {
  const { server, port } = await startVendor();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vendors.splice(vendors.indexOf(server), 1);
  return port;
}

/**
 * A bound profile with one write already queued — the shape where a healthy
 * stack enriches, so every sabotage case is a real fallback and not a
 * vacuously verbatim exchange.
 */
async function armedRig(options: { vendorPort?: number; injectionBudgetMs?: number } = {}): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-sabotage-"));
  dirs.push(root);
  const gateway = new CloudGateway({ stateRoot: root });
  await gateway.bindings.create(PROFILE, "upstream");
  await gateway.bindings.bindUid(PROFILE, UID);
  const vendorPort = options.vendorPort ?? (await startVendor()).port;
  const handle = await startCloudServer({
    host: "127.0.0.1", port: 0, gateway, observeHost: "127.0.0.1",
    // Short enough to make an overrun a fast test rather than a slow one.
    injectionBudgetMs: options.injectionBudgetMs ?? 150,
  });
  handles.push(handle);
  const accepted = await handle.writePath.accept(PROFILE, addRows(MCP_TASK, "queued by MCP"));
  if (accepted.kind !== "accepted") throw new Error(`arming the rig failed: ${JSON.stringify(accepted)}`);
  return { root, gateway, handle, partition: await gateway.registry.open(UID), vendorPort };
}

function post(rig: Rig, operation: string, fields: Record<string, string>): Promise<Answer> {
  const body = soapRequest(operation, fields);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: rig.handle.host,
      port: rig.handle.port,
      method: "POST",
      path: `http://127.0.0.1:${rig.vendorPort}/mlo/MLOInetSync.asmx`,
      headers: {
        "content-type": "text/xml; charset=utf-8",
        soapaction: `"http://www.mylifeorganized.net/${operation}"`,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

const CREDENTIALS = { loginBytes: "bG9naW4=", passwordBytes: "cGFzc3dvcmQ=" };

/** The whole session MLO drives: background poll, Get, Apply, Release. */
async function fullSync(rig: Rig, session = "s1"): Promise<{ fileTs: Answer; get: Answer; apply: Answer; release: Answer }> {
  const fileTs = await post(rig, "GetFileTS", { dataFileUID: UID, ...CREDENTIALS });
  const get = await post(rig, "GetModificationsBytesEx", {
    dataFileUID: UID, sessionID: session, newerThan: "100", ...CREDENTIALS,
  });
  const apply = await post(rig, "ApplyModificationsBytesEx", {
    dataFileUID: UID, sessionID: session, ...CREDENTIALS,
    data: base64Envelope(buildTaskAddDelta({
      uid: "{ABCDABCD-ABCD-ABCD-ABCD-ABCDABCDABCD}",
      caption: "MLO's own edit",
      createdDate: "2026-07-27T09:30:00",
      lastModified: "2026-07-27T09:30:00",
    })),
  });
  const release = await post(rig, "ReleaseSyncSessionBytes", { dataFileUID: UID, sessionID: session, ...CREDENTIALS });
  // The taps (capture, Apply observation, auto-init service) run after the
  // response is written; let them run so a failing one has its chance to
  // reach something it must not reach.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { fileTs, get, apply, release };
}

/** The task UIDs MLO would import from an answer's payload. */
function answerUids(answer: Answer): string[] {
  const fields = peekSoapResponseFields(answer.body, "GetModificationsBytesEx");
  const data = soapFieldText(fields, "data");
  if (!data) return [];
  return harvestTaskRows(unpackEnvelope(Buffer.from(data.replace(/\s+/g, ""), "base64"))).rows.map((row) => row.uid);
}

/**
 * The invariant's assertion: the session completed, and the vendor's own row
 * reached MLO — verbatim or enriched, but never lost, delayed into a failure,
 * or corrupted.
 */
function expectSyncSurvived(sync: Awaited<ReturnType<typeof fullSync>>): void {
  expect([sync.fileTs.status, sync.get.status, sync.apply.status, sync.release.status]).toEqual([200, 200, 200, 200]);
  expect(sync.get.body).not.toContain("Fault");
  expect(answerUids(sync.get)).toContain(VENDOR_TASK);
}

/**
 * Both rows reached MLO: the sabotage cost nothing at all, so the case also
 * proves the broken subsystem was not one injection needed.
 */
function expectEnriched(sync: Awaited<ReturnType<typeof fullSync>>): void {
  expectSyncSurvived(sync);
  expect(answerUids(sync.get).sort()).toEqual([MCP_TASK, VENDOR_TASK].sort());
}

/** Stronger: MLO's Get carried the vendor's bytes untouched — nothing was composed into it. */
function expectVerbatimGet(sync: Awaited<ReturnType<typeof fullSync>>): void {
  expectSyncSurvived(sync);
  expect(sync.get.body).toBe(VENDOR_ANSWERS.GetModificationsBytesEx);
  expect(answerUids(sync.get)).toEqual([VENDOR_TASK]);
}

/** Strongest: not one exchange of the session was touched. */
function expectVerbatim(sync: Awaited<ReturnType<typeof fullSync>>): void {
  expectVerbatimGet(sync);
  expect(sync.fileTs.body).toBe(VENDOR_ANSWERS.GetFileTS);
}

function throwing(message: string): () => never {
  return () => { throw new Error(message); };
}

/** A rejected promise, for the async seams the forward path awaits. */
function rejecting(message: string): () => Promise<never> {
  return () => Promise.reject(new Error(message));
}

/** A seam that never answers — a subsystem that hangs rather than fails. */
function hanging(): () => Promise<never> {
  return () => new Promise<never>(() => undefined);
}

/**
 * Break one method of a live subsystem and hand back the undo. Sabotage lands
 * on the instance the running stack holds — the prototype's method is what
 * `restore()` uncovers again.
 */
function sabotage<T extends object, K extends keyof T>(target: T, method: K, replacement: T[K]): () => void {
  target[method] = replacement;
  return () => { delete (target as Partial<T>)[method]; };
}

describe("the non-interference invariant under sabotage", () => {
  it("forwards enriched when nothing is broken — the control the cases fall back from", async () => {
    const rig = await armedRig();
    const sync = await fullSync(rig);
    expectEnriched(sync);
    // and the background poll was nudged, which is what induces the session
    const fields = peekSoapResponseFields(sync.fileTs.body, "GetFileTS");
    expect(soapFieldText(fields, "GetFileTSResult")).toBe("148");
  });

  it("survives a capture tap that throws on every exchange", async () => {
    const rig = await armedRig();
    sabotage(rig.gateway.registry, "resolveExisting", rejecting("capture: partition resolution exploded"));
    sabotage(rig.partition.journal, "record", rejecting("capture: journal unwritable"));

    // Capture is a contained tap: a total failure of it costs the session
    // nothing at all, injection included.
    expectEnriched(await fullSync(rig));
  });

  it("survives an unreadable row store", async () => {
    const rig = await armedRig();
    sabotage(rig.partition.rows, "ingest", rejecting("row store: unreadable"));
    sabotage(rig.partition.rows, "latest", rejecting("row store: unreadable"));

    // Injection still composes: authoring read the row store back when the
    // write was authored, the forward path does not.
    expectEnriched(await fullSync(rig));
  });

  it("survives a row-store file corrupted on disk (a gapped store, not a stub)", async () => {
    const rig = await armedRig();
    await fs.writeFile(path.join(rig.partition.dir, "rows.json"), "{ not json");

    expectEnriched(await fullSync(rig));
  });

  it("survives a corrupt injection queue — the vendor's payload, verbatim", async () => {
    const rig = await armedRig();
    await fs.writeFile(path.join(rig.partition.dir, "injection-queue.json"), "}{ truncated");

    expectVerbatim(await fullSync(rig));
  });

  it("survives an injection queue that throws on every read", async () => {
    const rig = await armedRig();
    sabotage(rig.partition.queue, "pending", rejecting("queue: unreadable"));

    expectVerbatim(await fullSync(rig));
  });

  it("survives a binding that has vanished — nothing to inject into, nothing refused", async () => {
    const rig = await armedRig();
    sabotage(rig.gateway.bindings, "forUid", async () => undefined);

    expectVerbatim(await fullSync(rig));
    // and the accepted write is still on disk: a lost binding loses no rows
    expect(await rig.partition.queue.pending()).toHaveLength(1);
  });

  it("survives a binding store that throws — the forward path reads nothing that can refuse", async () => {
    const rig = await armedRig();
    sabotage(rig.gateway.bindings, "forUid", rejecting("binding store: unreadable"));
    sabotage(rig.gateway.bindings, "forProfile", rejecting("binding store: unreadable"));

    expectVerbatim(await fullSync(rig));
  });

  it("survives a partition registry that cannot open anything", async () => {
    const rig = await armedRig();
    sabotage(rig.gateway.registry, "open", rejecting("partition: state root gone"));
    sabotage(rig.gateway.registry, "resolveExisting", rejecting("partition: state root gone"));
    sabotage(rig.gateway.registry, "list", rejecting("partition: state root gone"));

    expectVerbatim(await fullSync(rig));
  });

  it("survives every write-path service broken at once", async () => {
    const rig = await armedRig();
    sabotage(rig.handle.writePath, "enrichGetResponse", rejecting("service: broken"));
    sabotage(rig.handle.writePath, "nudgeFileTs", rejecting("service: broken"));
    sabotage(rig.handle.writePath, "observeApply", rejecting("service: broken"));
    sabotage(rig.handle.writePath, "observeRelease", throwing("service: broken"));

    expectVerbatim(await fullSync(rig));
  });

  it("survives every subsystem broken at once", async () => {
    const rig = await armedRig();
    sabotage(rig.gateway.bindings, "forUid", rejecting("all: broken"));
    sabotage(rig.gateway.bindings, "forProfile", rejecting("all: broken"));
    sabotage(rig.gateway.registry, "open", rejecting("all: broken"));
    sabotage(rig.gateway.registry, "resolveExisting", rejecting("all: broken"));
    sabotage(rig.gateway.registry, "list", rejecting("all: broken"));
    sabotage(rig.gateway.sightings, "note", rejecting("all: broken"));
    sabotage(rig.gateway.deadLetters, "record", rejecting("all: broken"));
    sabotage(rig.gateway, "ensureRoot", rejecting("all: broken"));
    sabotage(rig.partition.rows, "ingest", rejecting("all: broken"));
    sabotage(rig.partition.queue, "pending", rejecting("all: broken"));
    sabotage(rig.partition.journal, "record", rejecting("all: broken"));

    expectVerbatim(await fullSync(rig));
  });

  it("survives a subsystem that hangs instead of failing — no exchange is DELAYED either", async () => {
    const rig = await armedRig();
    // The two seams the forward path awaits, hung: nothing rejects, nothing
    // resolves. Only the budget ends this.
    sabotage(rig.partition.queue, "pending", hanging());

    expectVerbatim(await fullSync(rig));
  });

  it("falls back to the verbatim payload when composing fails: enriched or verbatim, never neither", async () => {
    const rig = await armedRig();
    // A queued write whose rows no envelope can carry: composing throws
    // halfway through injection, past every gate that could have refused it.
    const queued = await rig.partition.queue.pending();
    sabotage(rig.partition.queue, "pending", async () =>
      queued.map((write) => ({ ...write, rows: [{ section: "NoSuchSection", values: ["x"] }] })));

    // The Get falls back to the vendor's bytes; the background nudge still
    // fires, because a queue that cannot compose is still a non-empty queue.
    expectVerbatimGet(await fullSync(rig));
  });

  it("surfaces genuine vendor transport failure — the one failure MLO may observe", async () => {
    const rig = await armedRig({ vendorPort: await deadPort() });

    const get = await post(rig, "GetModificationsBytesEx", {
      dataFileUID: UID, sessionID: "s1", newerThan: "100", ...CREDENTIALS,
    });

    expect(get.status).toBe(502);
    expect(get.body).toContain("Fault");
    expect(get.body).toContain("vendor forward failed");
    // A transport failure is not a lost write: the row is still queued.
    expect(await rig.partition.queue.pending()).toHaveLength(1);
  });

  it("keeps the endpoint serving after a sabotaged session — nothing latches", async () => {
    const rig = await armedRig();
    const repair = sabotage(rig.partition.queue, "pending", rejecting("queue: unreadable"));
    expectVerbatim(await fullSync(rig, "s1"));

    // repair, and the very next session enriches again: no failure of any
    // subsystem leaves a mark on the forward path
    repair();
    expectEnriched(await fullSync(rig, "s2"));
  });
});

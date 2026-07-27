/**
 * The unattended verify-live items (spec section 8): the `GetFileTS` nudge
 * inducing a session, verbatim answers resuming when the queue empties,
 * four-verb propagation, and TTL expiry surfacing `expired` in the write
 * status plus the dead-letter aggregate.
 *
 * This suite talks to the real vendor through a real MLO. It MUTATES the
 * profile it is pointed at and the vendor-side cloud file behind it, and it
 * takes minutes — hence `MLO_LIVE=1` and a profile the operator names
 * explicitly. The manual half (conflict rounds) is a runbook:
 * `docs/testing-conflict-runbook.md`.
 *
 * Operator setup — the three steps no test can do (see the runbook):
 *   1. Open the disposable profile in MLO (the Demo profile).
 *   2. In its cloud sync profile: proxy host `127.0.0.1`, port =
 *      MLO_LIVE_CLOUD_PORT, "Use secure connection" UNCHECKED.
 *   3. Run with MLO_LIVE=1 MLO_LIVE_DATA_FILE=<path to that .ml>.
 */
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCloudServer, type CloudServerHandle } from "../../src/cloud/server.js";
import { SUMMARY_FILE } from "../../src/cloud/sync-observer.js";
import { nowIso } from "../../src/services/outline-authoring.js";
import { generateGuid } from "../../src/cloud/guid.js";
import {
  buildTaskAddDelta,
  buildTaskDeleteDelta,
  buildTaskUpdatesDelta,
  deltaRowsFromDocument,
  type SectionRow,
} from "../../src/cloud/mlo-schema.js";
import type { PartitionStore } from "../../src/cloud/partition.js";
import { MLO_EXE } from "./helpers.js";

const LIVE = process.env.MLO_LIVE === "1";
const DATA_FILE = process.env.MLO_LIVE_DATA_FILE ?? "";
const PORT = Number(process.env.MLO_LIVE_CLOUD_PORT ?? "8282");

/** MLO's background `GetFileTS` poll interval, measured live (ticket 13). */
const POLL_CYCLE_MS = 90_000;
/** Budget for a delivery that has to wait for MLO's own cadence. */
const DELIVERY_BUDGET_MS = 5 * POLL_CYCLE_MS;

interface WriteReceipt {
  writeId: string;
  uid: string;
  status: string;
  expiresAt: string;
}

interface StatusBody {
  writeId: string;
  status: "accepted" | "delivered" | "verified" | "expired" | "superseded";
  detail?: string;
}

/**
 * Where a finding outlives the run. The spec asks for the nudge fallback to be
 * "recorded" (section 9), so console output is not enough — this file is the
 * artefact the next reader of the acceptance bar looks at.
 */
const FINDINGS_FILE = process.env.MLO_LIVE_FINDINGS
  ?? path.join(os.tmpdir(), "mlo-live-findings.jsonl");

const findings: string[] = [];

async function record(finding: string): Promise<void> {
  findings.push(finding);
  console.log(`[live finding] ${finding}`);
  await fs.appendFile(
    FINDINGS_FILE,
    `${JSON.stringify({ at: new Date().toISOString(), profile: DATA_FILE, finding })}\n`,
    "utf8",
  );
}

async function postWrite(rows: readonly SectionRow[]): Promise<WriteReceipt> {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: DATA_FILE, rows }),
  });
  const body = (await response.json()) as WriteReceipt & { title?: string };
  expect(response.status, `write refused: ${body.title ?? ""}`).toBe(200);
  return body;
}

async function writeStatus(writeId: string): Promise<StatusBody> {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/write/${encodeURIComponent(writeId)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as StatusBody;
}

async function waitFor<T>(
  what: string,
  budgetMs: number,
  probe: () => Promise<T | undefined>,
  intervalMs = 5_000,
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const hit = await probe();
    if (hit !== undefined) return hit;
    if (Date.now() >= deadline) {
      console.log(`[live] gave up waiting for ${what} after ${Math.round(budgetMs / 1000)}s`);
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Landed = MLO's own Apply echoed the row with matching content (or better). */
async function waitForLanding(writeId: string, budgetMs = DELIVERY_BUDGET_MS): Promise<StatusBody> {
  const landed = await waitFor(`write ${writeId} to land`, budgetMs, async () => {
    const status = await writeStatus(writeId);
    return status.status === "accepted" ? undefined : status;
  });
  return landed ?? (await writeStatus(writeId));
}

function mlo(...args: string[]): void {
  // Always the explicit data file: a pathless invocation can silently no-op
  // against a stale registry `LastDBFile` (ticket 13, trap 1).
  execFileSync(MLO_EXE, [DATA_FILE, ...args], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
}

/** The fallback delivery trigger: a local modification gives QuickSync a session to open. */
function induceSessionThroughLocalMod(): void {
  mlo(`-AddSubtask=live-suite nudge fallback ${new Date().toISOString()}`, "-console");
  mlo("-QuickSync", "-console");
}

/**
 * Wait for a write to land on MLO's own cadence, and if the nudge did not open
 * a session in time, fall back to riding one we induce (spec section 9's
 * "no worse than today"). Returns the terminal status either way.
 */
async function landOnItsOwnOrRidingASession(writeId: string, ownBudgetMs: number): Promise<StatusBody> {
  const landed = await waitForLanding(writeId, ownBudgetMs);
  if (landed.status !== "accepted") return landed;
  induceSessionThroughLocalMod();
  return waitForLanding(writeId);
}

/** Count of vendor sync sessions the observer has summarized so far. */
async function sessionCount(stateRoot: string): Promise<number> {
  const raw = await fs.readFile(path.join(stateRoot, SUMMARY_FILE), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length)
    .map((line) => JSON.parse(line) as { kind?: string; operation?: string })
    .filter((entry) => entry.kind === "soap" && entry.operation !== "GetFileTS").length;
}

function guiRunning(): boolean {
  const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq mlo.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return out.toLowerCase().includes("mlo.exe");
}

describe.skipIf(!LIVE)("verify-live: the resident write path against a real MLO", () => {
  let handle: CloudServerHandle;
  let stateRoot: string;
  let partition: PartitionStore;
  let addedUid: string;

  beforeAll(async () => {
    expect(DATA_FILE, "MLO_LIVE_DATA_FILE must name the disposable profile MLO has open").not.toBe("");
    expect(existsSync(DATA_FILE), `${DATA_FILE} does not exist`).toBe(true);
    expect(existsSync(MLO_EXE), `${MLO_EXE} does not exist`).toBe(true);
    expect(guiRunning(), "open the profile in MLO first — the live items ride its own sync sessions").toBe(true);
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-live-write-"));
    handle = await startCloudServer({
      host: "127.0.0.1",
      port: PORT,
      stateRoot,
      mloExePath: MLO_EXE,
    });
    console.log(`[live] resident on 127.0.0.1:${handle.port}, state root ${stateRoot}`);
  }, 180_000);

  afterAll(async () => {
    await handle?.stop();
    if (findings.length) console.log(`[live] findings:\n- ${findings.join("\n- ")}`);
  });

  it("binds the profile's partition from one proxied sync", async () => {
    mlo("-QuickSync", "-console");
    const bound = await waitFor("the profile to bind", 3 * POLL_CYCLE_MS, async () => {
      const result = await handle.gateway.boundPartition(DATA_FILE);
      return result.kind === "bound" ? result.partition : undefined;
    });
    expect(bound, "no sync reached the proxy — check the proxy host/port and that secure connection is OFF").toBeDefined();
    partition = bound!;
  }, 5 * POLL_CYCLE_MS);

  it("delivers a queued add with no local activity — the GetFileTS nudge", async () => {
    addedUid = generateGuid();
    const rows = deltaRowsFromDocument(
      buildTaskAddDelta({
        uid: addedUid,
        caption: `live-suite add ${new Date().toISOString()}`,
        createdDate: nowIso(),
        lastModified: nowIso(),
      }),
    );
    const receipt = await postWrite(rows);
    expect(receipt.status).toBe("accepted");

    // No QuickSync, no local edit: the only thing that can open a session is
    // MLO acting on the advanced GetFileTS answer.
    let landed = await waitForLanding(receipt.writeId, 3 * POLL_CYCLE_MS);
    if (landed.status === "accepted") {
      await record(
        "the GetFileTS nudge did NOT induce a session within 3 poll cycles — delivery falls back to " +
          "riding the next natural session (no worse than today); revisit delivery latency vs the 15-minute TTL",
      );
      induceSessionThroughLocalMod();
      landed = await waitForLanding(receipt.writeId);
    }
    expect(landed.status, `write never landed: ${landed.detail ?? ""}`).toMatch(/^(delivered|verified)$/);
  }, 10 * POLL_CYCLE_MS);

  it("answers GetFileTS verbatim once the queue empties — no session it did not need", async () => {
    expect((await partition.queue.pending()).length).toBe(0);
    // The decision itself, against the live partition: with nothing queued the
    // nudge declines to rewrite the vendor's answer, whatever the poll carries.
    const bound = await handle.gateway.boundPartition(DATA_FILE);
    expect(bound.kind).toBe("bound");
    const rewritten = await handle.writePath.nudgeFileTs(
      { dataFileUID: (bound as Extract<typeof bound, { kind: "bound" }>).binding.dataFileUID },
      { status: 200, headers: {}, body: Buffer.alloc(0) },
    );
    expect(rewritten, "an empty queue must leave the vendor's stamp alone").toBeUndefined();

    // And the consequence MLO shows: two poll cycles of quiet. A nudge still
    // firing on an empty queue would open a session MLO had no reason to open.
    const before = await sessionCount(stateRoot);
    await new Promise((resolve) => setTimeout(resolve, 2 * POLL_CYCLE_MS + 15_000));
    expect(await sessionCount(stateRoot)).toBe(before);
  }, 4 * POLL_CYCLE_MS);

  it("propagates update, complete and delete on top of the added task", async () => {
    // Each verb authors from the row store as it stands NOW: an update rides a
    // full-record replacement, so patching a stale row would silently revert
    // whatever the previous verb landed.
    const rowsFor = async (patch: Record<string, string>): Promise<SectionRow[]> => {
      const source = await partition.rows.latest(addedUid);
      expect(source.kind, `no captured row for ${addedUid} to author against`).toBe("row");
      const captured = source as Extract<typeof source, { kind: "row" }>;
      return deltaRowsFromDocument(
        buildTaskUpdatesDelta([{ header: captured.header, row: captured.cells, patch }]),
      );
    };

    const verbs: [string, () => Promise<SectionRow[]>][] = [
      ["update", () => rowsFor({ Caption: "live-suite renamed", LastModified: nowIso() })],
      ["complete", () => rowsFor({ CompletionDateTime: nowIso(), LastModified: nowIso() })],
      ["delete", async () => deltaRowsFromDocument(buildTaskDeleteDelta([addedUid]))],
    ];
    for (const [verb, rows] of verbs) {
      const receipt = await postWrite(await rows());
      const landed = await landOnItsOwnOrRidingASession(receipt.writeId, 2 * POLL_CYCLE_MS);
      expect(landed.status, `${verb} never landed: ${landed.detail ?? ""}`).toMatch(/^(delivered|verified)$/);
    }
  }, 30 * POLL_CYCLE_MS);
});

describe.skipIf(!LIVE)("verify-live: TTL expiry", () => {
  let handle: CloudServerHandle;
  let stateRoot: string;

  beforeAll(async () => {
    expect(DATA_FILE).not.toBe("");
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-live-ttl-"));
    handle = await startCloudServer({
      host: "127.0.0.1",
      port: PORT,
      stateRoot,
      mloExePath: MLO_EXE,
      // Short enough to observe unattended; the mechanism is the production one.
      writeTtlMs: 30_000,
    });
    // Sync twice: the first flushes whatever local modifications the earlier
    // legs left behind, so nothing but this leg's own queue can open a session
    // while the row ages out.
    mlo("-QuickSync", "-console");
    const bound = await waitFor("the profile to bind", 3 * POLL_CYCLE_MS, async () => {
      const result = await handle.gateway.boundPartition(DATA_FILE);
      return result.kind === "bound" ? result.partition : undefined;
    });
    expect(bound, "the TTL leg needs its own bound partition").toBeDefined();
    mlo("-QuickSync", "-console");
  }, 6 * POLL_CYCLE_MS);

  afterAll(async () => { await handle?.stop(); });

  it("surfaces `expired` in the write status and the dead-letter aggregate", async () => {
    // Nothing drives a sync: the row should age out where it sits. But the
    // queue is non-empty, so a GetFileTS poll landing inside the TTL window
    // legitimately nudges MLO into delivering it instead — that outcome is the
    // nudge working, not expiry failing, so try again on a fresh write.
    let receipt: WriteReceipt | undefined;
    let expired: StatusBody | undefined;
    for (let attempt = 1; attempt <= 3 && expired?.status !== "expired"; attempt += 1) {
      receipt = await postWrite(
        deltaRowsFromDocument(
          buildTaskAddDelta({
            uid: generateGuid(),
            caption: `live-suite ttl ${new Date().toISOString()}`,
            createdDate: nowIso(),
            lastModified: nowIso(),
          }),
        ),
      );
      // Expiry is swept lazily wherever the queue is consulted, so the status
      // read past the TTL is what performs it.
      await new Promise((resolve) => setTimeout(resolve, 35_000));
      expired = await writeStatus(receipt.writeId);
      if (expired.status !== "expired") {
        await record(`TTL attempt ${attempt} read "${expired.status}" — a sync session beat the TTL window`);
      }
    }
    expect(
      expired!.status,
      "no attempt aged out: MLO kept opening sessions inside the TTL window — rerun on a quiet profile",
    ).toBe("expired");

    const bound = await handle.gateway.boundPartition(DATA_FILE);
    expect(bound.kind).toBe("bound");
    const gauge = await (bound as Extract<typeof bound, { kind: "bound" }>).partition.writeGauge(5);
    expect(gauge.pendingWrites).toBe(0);
    expect(gauge.deadLetters.map((dead) => dead.writeId)).toContain(receipt!.writeId);
    expect(gauge.deadLetters[0]!.status).toBe("expired");
  }, 4 * POLL_CYCLE_MS);
});

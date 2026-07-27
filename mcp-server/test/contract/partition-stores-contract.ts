import { describe, expect, it } from "vitest";
import { buildTaskAddDelta, buildTaskDeleteDelta } from "../../src/cloud/mlo-schema.js";
import { findSection } from "../../src/cloud/csv.js";
import type { CaptureJournal } from "../../src/cloud/capture-journal.js";
import type { InjectionQueue, QueuedWrite } from "../../src/cloud/injection-queue.js";
import type { RowStore } from "../../src/cloud/row-store.js";
import type { WriteOutcome, WriteOutcomeStore } from "../../src/cloud/write-outcomes.js";
import type { BindingStoreApi, DeadLetterStoreApi, SightingStoreApi } from "../fakes/fake-state-stores.js";

/**
 * Parameterized contracts for PartitionStore's stores and the small stores
 * beside it (spec section 8): run against the fakes always and the file-backed
 * implementations on temp dirs, so the fakes cannot drift.
 */

const UID_A = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const UID_B = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";
const PLACE_UID = "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}";
const FLAG_UID = "{DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD}";

export function addDocument(uid: string, caption: string) {
  return buildTaskAddDelta({
    uid,
    caption,
    createdDate: "2026-07-27T10:00:00",
    lastModified: "2026-07-27T10:00:00",
  });
}

export function describeRowStoreContract(name: string, makeStore: () => RowStore | Promise<RowStore>): void {
  describe(`RowStore contract — ${name}`, () => {
    it("returns the latest captured row by UID, across ingests", async () => {
      const store = await makeStore();
      await store.ingest(addDocument(UID_A, "first caption"), "vendor-get");
      await store.ingest(addDocument(UID_A, "second caption"), "mlo-apply");
      const lookup = await store.latest(UID_A);
      expect(lookup.kind).toBe("row");
      if (lookup.kind !== "row") return;
      expect(lookup.cells[lookup.header.indexOf("Caption")]).toBe("second caption");
      expect(lookup.source).toBe("mlo-apply");
      expect(await store.size()).toBe(1);
    });

    it("misses with the typed unknown-row refusal carrying the repull remedy", async () => {
      const store = await makeStore();
      const lookup = await store.latest(UID_B);
      expect(lookup.kind).toBe("unknown-row");
      if (lookup.kind !== "unknown-row") return;
      expect(lookup.remedy).toBe("repull");
      expect(lookup.retryable).toBe("after-user-action");
      expect(lookup.uid).toBe(UID_B);
    });

    it("normalizes UID spellings on lookup", async () => {
      const store = await makeStore();
      await store.ingest(addDocument(UID_A, "task"), "vendor-get");
      const lookup = await store.latest(UID_A.slice(1, -1).toLowerCase());
      expect(lookup.kind).toBe("row");
    });

    it("drops rows a tombstone deletes", async () => {
      const store = await makeStore();
      await store.ingest(addDocument(UID_A, "doomed"), "vendor-get");
      const { tombstones } = await store.ingest(buildTaskDeleteDelta([UID_A]), "vendor-get");
      expect(tombstones).toBe(1);
      expect((await store.latest(UID_A)).kind).toBe("unknown-row");
      expect(await store.size()).toBe(0);
    });

    it("replaceAll rebuilds the store from one document", async () => {
      const store = await makeStore();
      await store.ingest(addDocument(UID_A, "old world"), "vendor-get");
      const { upserts } = await store.replaceAll(addDocument(UID_B, "new world"), "history-pull");
      expect(upserts).toBe(1);
      expect((await store.latest(UID_A)).kind).toBe("unknown-row");
      expect((await store.latest(UID_B)).kind).toBe("row");
    });

    it("carries each row's relation sets, replacing them per capture", async () => {
      const store = await makeStore();
      const withRelations = buildTaskAddDelta({
        uid: UID_A,
        caption: "with contexts",
        createdDate: "2026-07-27T10:00:00",
        lastModified: "2026-07-27T10:00:00",
        placeUids: [PLACE_UID],
        dependencyUids: [UID_B],
      });
      await store.ingest(withRelations, "vendor-get");
      let lookup = await store.latest(UID_A);
      expect(lookup.kind).toBe("row");
      if (lookup.kind !== "row") return;
      expect(lookup.placeUids).toEqual([PLACE_UID]);
      expect(lookup.dependencyUids).toEqual([UID_B]);
      // No relation rows beside an emitted task means "none", not "unchanged".
      await store.ingest(addDocument(UID_A, "contexts cleared"), "mlo-apply");
      lookup = await store.latest(UID_A);
      if (lookup.kind !== "row") throw new Error("expected a row");
      expect(lookup.placeUids).toEqual([]);
      expect(lookup.dependencyUids).toEqual([]);
    });

    it("accumulates the context/flag catalog and the starred-order high-water mark", async () => {
      const store = await makeStore();
      const document = addDocument(UID_A, "starred");
      findSection(document, "Places")!.rows.push([PLACE_UID, "@Home", "", "", "", "", "", "", "", "", "", ""]);
      findSection(document, "Flags")!.rows.push([FLAG_UID, "Hot", "", "", "", ""]);
      findSection(document, "TodoView.ManualOrdering.Starred")!.rows.push([UID_A, "1500"]);
      await store.ingest(document, "vendor-get");
      // A later capture that mentions neither keeps both: catalogs accumulate.
      await store.ingest(addDocument(UID_B, "plain"), "vendor-get");
      const catalog = await store.catalog();
      expect(catalog.places).toEqual([{ uid: PLACE_UID, caption: "@Home" }]);
      expect(catalog.flags).toEqual([{ uid: FLAG_UID, caption: "Hot" }]);
      expect(catalog.maxStarredOrderIndex).toBe(1500);
    });

    it("view answers captions synchronously for captured rows only", async () => {
      const store = await makeStore();
      await store.ingest(addDocument(UID_A, "visible"), "vendor-get");
      const view = store.view();
      expect(view.captionOf(UID_A)).toBe("visible");
      expect(view.captionOf(UID_A.toLowerCase())).toBe("visible");
      expect(view.captionOf(UID_B)).toBeUndefined();
      expect(view.captionOf("not-a-guid")).toBeUndefined();
    });

    it("view serves every row's alignment columns", async () => {
      const store = await makeStore();
      await store.ingest(addDocument(UID_A, "parent"), "vendor-get");
      await store.ingest(
        buildTaskAddDelta({
          uid: UID_B,
          caption: "child",
          parentUid: UID_A,
          itemIndex: "250",
          createdDate: "2026-07-27T10:00:00",
          lastModified: "2026-07-27T10:00:00",
        }),
        "vendor-get",
      );
      const rows = store.view().alignmentRows();
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ uid: UID_A, caption: "parent", parentUid: "", itemIndex: 100 });
      expect(rows).toContainEqual({ uid: UID_B, caption: "child", parentUid: UID_A, itemIndex: 250 });
    });
  });
}

export function describeCaptureJournalContract(
  name: string,
  makeJournal: (now: () => Date, cap?: number) => CaptureJournal | Promise<CaptureJournal>,
): void {
  describe(`CaptureJournal contract — ${name}`, () => {
    it("retains entries oldest-first with their outcomes and details", async () => {
      const journal = await makeJournal(() => new Date());
      await journal.record("ok", "get: 2 rows, 0 tombstones");
      await journal.record("failed", "apply: unreadable payload");
      const entries = await journal.entries();
      expect(entries.map((entry) => entry.outcome)).toEqual(["ok", "failed"]);
      expect(entries[0]!.detail).toBe("get: 2 rows, 0 tombstones");
    });

    it("derives an ok gauge when the latest in-window entry captured", async () => {
      const journal = await makeJournal(() => new Date());
      await journal.record("failed");
      await journal.record("ok");
      const gauge = await journal.gauge();
      expect(gauge.state).toBe("ok");
      expect(gauge.counts.ok).toBe(1);
      expect(gauge.counts.failed).toBe(1);
      expect(gauge.lastOkAt).toBeTruthy();
    });

    it("derives a degraded gauge when the latest in-window entry did not capture", async () => {
      const journal = await makeJournal(() => new Date());
      await journal.record("ok");
      await journal.record("tls-connect-seen", "sync.example:443");
      expect((await journal.gauge()).state).toBe("degraded");
    });

    it("is a bounded ring: the oldest entries fall off past the cap", async () => {
      const journal = await makeJournal(() => new Date(), 3);
      await journal.record("failed", "first — should fall off");
      await journal.record("ok");
      await journal.record("ok");
      await journal.record("ok");
      const entries = await journal.entries();
      expect(entries).toHaveLength(3);
      expect(entries.every((entry) => entry.outcome === "ok")).toBe(true);
    });

    it("ages old entries out of the gauge: an idle window is idle, not broken", async () => {
      let now = new Date("2026-07-27T10:00:00Z");
      const journal = await makeJournal(() => now);
      await journal.record("failed");
      now = new Date("2026-07-29T10:00:00Z"); // two days later, default 24 h window
      const gauge = await journal.gauge();
      expect(gauge.state).toBe("idle");
      expect(gauge.counts.failed).toBe(0);
      // the ring still holds the evidence; only the gauge aged it out
      expect(await journal.entries()).toHaveLength(1);
    });
  });
}

export function sampleWrite(writeId: string, uid = UID_A): QueuedWrite {
  return {
    writeId,
    uid,
    verb: "add",
    caption: "queued task",
    rows: [{ section: "TodoItems", values: [uid, "queued task"] }],
    queuedAt: "2026-07-27T10:00:00",
    expiresAt: "2026-07-27T10:15:00",
  };
}

export function describeInjectionQueueContract(
  name: string,
  makeQueue: () => InjectionQueue | Promise<InjectionQueue>,
): void {
  describe(`InjectionQueue contract — ${name}`, () => {
    it("keeps enqueued writes pending, oldest first", async () => {
      const queue = await makeQueue();
      await queue.enqueue(sampleWrite("w1"));
      await queue.enqueue(sampleWrite("w2", UID_B));
      expect((await queue.pending()).map((write) => write.writeId)).toEqual(["w1", "w2"]);
    });

    it("two queued writes can share one uid but never one writeId", async () => {
      const queue = await makeQueue();
      await queue.enqueue(sampleWrite("w1"));
      await queue.enqueue(sampleWrite("w2"));
      expect(await queue.pending()).toHaveLength(2);
      await expect(queue.enqueue(sampleWrite("w1"))).rejects.toThrow(/already queued/);
    });

    it("remove takes exactly one write out and returns it", async () => {
      const queue = await makeQueue();
      await queue.enqueue(sampleWrite("w1"));
      await queue.enqueue(sampleWrite("w2"));
      const removed = await queue.remove("w1");
      expect(removed?.writeId).toBe("w1");
      expect((await queue.pending()).map((write) => write.writeId)).toEqual(["w2"]);
      expect(await queue.remove("w1")).toBeUndefined();
    });
  });
}

function sampleOutcome(writeId: string, status: WriteOutcome["status"]): WriteOutcome {
  return {
    writeId,
    uid: UID_A,
    verb: "update",
    caption: "resolved task",
    status,
    at: "2026-07-27T10:20:00Z",
    detail: `${status} in a test`,
  };
}

export function describeWriteOutcomeStoreContract(
  name: string,
  makeStore: (cap?: number) => WriteOutcomeStore | Promise<WriteOutcomeStore>,
): void {
  describe(`WriteOutcomeStore contract — ${name}`, () => {
    it("answers byId with the recorded resolution", async () => {
      const store = await makeStore();
      await store.record(sampleOutcome("w1", "delivered"));
      await store.record(sampleOutcome("w2", "superseded"));
      expect((await store.byId("w1"))?.status).toBe("delivered");
      expect((await store.byId("w2"))?.status).toBe("superseded");
      expect(await store.byId("w3")).toBeUndefined();
      expect((await store.all()).map((outcome) => outcome.writeId)).toEqual(["w1", "w2"]);
    });

    it("is a bounded ring: the oldest receipts fall off past the cap", async () => {
      const store = await makeStore(2);
      await store.record(sampleOutcome("w1", "expired"));
      await store.record(sampleOutcome("w2", "expired"));
      await store.record(sampleOutcome("w3", "expired"));
      expect(await store.byId("w1")).toBeUndefined();
      expect((await store.all()).map((outcome) => outcome.writeId)).toEqual(["w2", "w3"]);
    });
  });
}

export function describeBindingStoreContract(
  name: string,
  makeStore: () => BindingStoreApi | Promise<BindingStoreApi>,
): void {
  describe(`BindingStore contract — ${name}`, () => {
    it("creates once per profile and binds a UID exactly once", async () => {
      const store = await makeStore();
      await store.create("C:/profiles/a.ml", "upstream");
      await store.bindUid("C:/profiles/a.ml", UID_A);
      expect((await store.forProfile("C:/PROFILES/A.ML"))?.dataFileUID).toBe(UID_A);
      expect((await store.forUid(UID_A))?.profilePath).toBe("C:/profiles/a.ml");
      await expect(store.bindUid("C:/profiles/a.ml", UID_B)).rejects.toThrow(/already bound/);
    });

    it("fails closed when a UID would bind to a second profile", async () => {
      const store = await makeStore();
      await store.create("C:/profiles/a.ml", "upstream");
      await store.bindUid("C:/profiles/a.ml", UID_A);
      await store.create("C:/profiles/b.ml", "upstream");
      await expect(store.bindUid("C:/profiles/b.ml", UID_A)).rejects.toThrow(/different profile/);
    });

    it("unbindUid drops only the UID pointer", async () => {
      const store = await makeStore();
      await store.create("C:/profiles/a.ml", "upstream");
      await store.bindUid("C:/profiles/a.ml", UID_A);
      await store.unbindUid("C:/profiles/a.ml");
      const binding = await store.forProfile("C:/profiles/a.ml");
      expect(binding).toBeDefined();
      expect(binding?.dataFileUID).toBeUndefined();
    });
  });
}

export function describeSightingStoreContract(
  name: string,
  makeStore: () => SightingStoreApi | Promise<SightingStoreApi>,
): void {
  describe(`SightingStore contract — ${name}`, () => {
    it("counts repeat sightings per UID", async () => {
      const store = await makeStore();
      await store.note(UID_A);
      await store.note(UID_A);
      await store.note(UID_B);
      const sightings = await store.all();
      expect(sightings.map((sighting) => sighting.dataFileUID).sort()).toEqual([UID_A, UID_B]);
      expect(sightings.find((sighting) => sighting.dataFileUID === UID_A)?.count).toBe(2);
      expect(sightings.find((sighting) => sighting.dataFileUID === UID_B)?.count).toBe(1);
    });
  });
}

export function describeDeadLetterStoreContract(
  name: string,
  makeStore: () => DeadLetterStoreApi | Promise<DeadLetterStoreApi>,
): void {
  describe(`DeadLetterStore contract — ${name}`, () => {
    it("preserves refused writes verbatim, oldest first", async () => {
      const store = await makeStore();
      await store.record({ at: "2026-07-27T10:00:00Z", tool: "add_tasks", reason: "endpoint-down", content: "buy milk" });
      await store.record({ at: "2026-07-27T10:01:00Z", tool: "add_tasks", reason: "endpoint-down", content: "call mom" });
      const letters = await store.all();
      expect(letters.map((letter) => letter.content)).toEqual(["buy milk", "call mom"]);
      expect(store.file()).toBeTruthy();
    });
  });
}

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PartitionRegistry } from "../../src/cloud/partition.js";
import { FileRowStore } from "../../src/cloud/row-store.js";
import { FileCaptureJournal } from "../../src/cloud/capture-journal.js";
import { FileInjectionQueue } from "../../src/cloud/injection-queue.js";
import { BindingStore } from "../../src/cloud/binding.js";
import { SightingStore } from "../../src/cloud/sightings.js";
import { DeadLetterStore } from "../../src/cloud/dead-letter.js";
import { FakeRowStore } from "../fakes/fake-row-store.js";
import { FakeCaptureJournal } from "../fakes/fake-capture-journal.js";
import { FakeInjectionQueue } from "../fakes/fake-injection-queue.js";
import { FileWriteOutcomes } from "../../src/cloud/write-outcomes.js";
import { FakeBindingStore, FakeDeadLetterStore, FakeSightingStore, FakeWriteOutcomeStore } from "../fakes/fake-state-stores.js";
import {
  addDocument,
  describeBindingStoreContract,
  describeCaptureJournalContract,
  describeDeadLetterStoreContract,
  describeInjectionQueueContract,
  describeRowStoreContract,
  describeSightingStoreContract,
  describeWriteOutcomeStoreContract,
  sampleWrite,
} from "../contract/partition-stores-contract.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-partition-"));
  dirs.push(dir);
  return dir;
}

const UID = "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}";

// One contract, every implementation: the file-backed stores and their fakes
// must be indistinguishable to a caller (spec section 8).
describeRowStoreContract("file-backed", async () => new FileRowStore(await tempDir()));
describeRowStoreContract("fake", () => new FakeRowStore());
describeCaptureJournalContract("file-backed", async (now, cap) => new FileCaptureJournal(await tempDir(), now, cap));
describeCaptureJournalContract("fake", (now, cap) => new FakeCaptureJournal(cap, now));
describeInjectionQueueContract("file-backed", async () => new FileInjectionQueue(await tempDir()));
describeInjectionQueueContract("fake", () => new FakeInjectionQueue());
describeWriteOutcomeStoreContract("file-backed", async (cap) => new FileWriteOutcomes(await tempDir(), cap));
describeWriteOutcomeStoreContract("fake", (cap) => new FakeWriteOutcomeStore(cap));
describeBindingStoreContract("file-backed", async () => new BindingStore(await tempDir()));
describeBindingStoreContract("fake", () => new FakeBindingStore());
describeSightingStoreContract("file-backed", async () => new SightingStore(await tempDir()));
describeSightingStoreContract("fake", () => new FakeSightingStore());
describeDeadLetterStoreContract("file-backed", async () => new DeadLetterStore(await tempDir()));
describeDeadLetterStoreContract("fake", () => new FakeDeadLetterStore());

describe("PartitionStore handle", () => {
  it("exposes rows, journal, and queue under one per-UID handle that persists across opens", async () => {
    const root = await tempDir();
    const first = await new PartitionRegistry(root).open(UID);
    await first.rows.ingest(addDocument(UID, "persisted row"), "vendor-get");
    await first.journal.record("ok", "get: 1 rows, 0 tombstones");
    await first.queue.enqueue(sampleWrite("w1", UID));

    // a second process: fresh registry over the same root
    const second = await new PartitionRegistry(root).open(UID);
    const lookup = await second.rows.latest(UID);
    expect(lookup.kind).toBe("row");
    expect((await second.journal.entries())[0]!.outcome).toBe("ok");
    expect((await second.queue.pending())[0]!.writeId).toBe("w1");
  });

  it("keeps every partition file inside the partition directory — the layout is private", async () => {
    const root = await tempDir();
    const partition = await new PartitionRegistry(root).open(UID);
    await partition.rows.ingest(addDocument(UID, "row"), "vendor-get");
    await partition.journal.record("ok");
    await partition.queue.enqueue(sampleWrite("w1", UID));
    const outside = (await fs.readdir(root)).filter((name) => name !== "partitions");
    expect(outside).toEqual([]);
    const inside = await fs.readdir(partition.dir);
    expect(inside.length).toBeGreaterThanOrEqual(4); // meta + the three stores, names private
  });

  it("a reader sees rows another store instance persisted after it first read", async () => {
    const dir = await tempDir();
    const writer = new FileRowStore(dir);
    const reader = new FileRowStore(dir);
    expect((await reader.latest(UID)).kind).toBe("unknown-row");
    await writer.ingest(addDocument(UID, "late arrival"), "vendor-get");
    expect((await reader.latest(UID)).kind).toBe("row");
  });

  it("survives a store file that vanished mid-flight: an absent file is an empty store", async () => {
    const dir = await tempDir();
    const store = new FileRowStore(dir);
    await store.ingest(addDocument(UID, "row"), "vendor-get");
    await fs.rm(path.join(dir, "rows.json"));
    const fresh = new FileRowStore(dir);
    expect((await fresh.latest(UID)).kind).toBe("unknown-row");
  });
});

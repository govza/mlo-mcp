import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeDataFileUid, partitionKey, PartitionRegistry } from "../../src/cloud/partition.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const UID_A = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const UID_B = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";

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
    const registry = new PartitionRegistry(root);
    expect(await registry.resolveExisting(UID_A)).toBeUndefined();
    const partition = await registry.open(UID_A, "local");
    expect(partition.uid).toBe(UID_A);
    expect(await partition.lifecycle()).toBe("uninitialized");
    expect(await partition.mode()).toBe("local");
    expect(await registry.resolveExisting(UID_A)).toBe(partition);
    const listed = await registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.dataFileUID).toBe(UID_A);
  });

  it("keeps two partitions in separate directories with independent meta", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-root-")); dirs.push(root);
    const registry = new PartitionRegistry(root);
    const a = await registry.open(UID_A, "local");
    const b = await registry.open(UID_B);
    expect(a.dir).not.toBe(b.dir);
    await a.setLifecycle("ready");
    expect(await a.lifecycle()).toBe("ready");
    expect(await b.lifecycle()).toBe("uninitialized");
    expect(await b.mode()).toBe("upstream");
  });
});

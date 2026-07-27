import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BindingStore } from "../../src/cloud/binding.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const UID_A = "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}";
const UID_B = "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}";

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mlo-cloud-bind-"));
  dirs.push(dir);
  return dir;
}

describe("BindingStore", () => {
  it("creates bindings, deduplicates by canonical path, and refuses silent mode changes", async () => {
    const store = new BindingStore(await root());
    const created = await store.create("C:\\Profiles\\Personal.ml", "upstream");
    expect(created.dataFileUID).toBeUndefined();
    // NTFS case-insensitivity: a respelled path is the same profile.
    const same = await store.create("c:\\profiles\\PERSONAL.ML", "upstream");
    expect(same.createdAt).toBe(created.createdAt);
    await expect(store.create("C:\\Profiles\\Personal.ml", "local"))
      .rejects.toThrow("already bound in \"upstream\" mode");
  });

  it("binds exactly one UID per profile and one profile per UID, failing closed on conflicts", async () => {
    const store = new BindingStore(await root());
    await store.create("C:\\a.ml", "local");
    await store.create("C:\\b.ml", "local");
    await store.bindUid("C:\\a.ml", UID_A);
    expect((await store.forProfile("C:\\a.ml"))?.dataFileUID).toBe(UID_A);
    // Re-binding the same UID is idempotent; a different UID fails closed.
    await store.bindUid("C:\\a.ml", UID_A.toLowerCase());
    await expect(store.bindUid("C:\\a.ml", UID_B)).rejects.toThrow("already bound to a different dataFileUID");
    // The same UID cannot serve two profiles.
    await expect(store.bindUid("C:\\b.ml", UID_A)).rejects.toThrow("already bound to a different profile");
    // Binding an unknown profile fails closed rather than creating implicitly.
    await expect(store.bindUid("C:\\c.ml", UID_B)).rejects.toThrow("no binding exists");
  });

  it("persists across instances and supports explicit unbind for rebinds", async () => {
    const dir = await root();
    const store = new BindingStore(dir);
    await store.create("C:\\a.ml", "local");
    await store.bindUid("C:\\a.ml", UID_A);
    const reloaded = new BindingStore(dir);
    expect((await reloaded.forUid(UID_A))?.profilePath).toBe("C:\\a.ml");
    await reloaded.unbindUid("C:\\a.ml");
    expect((await reloaded.forProfile("C:\\a.ml"))?.dataFileUID).toBeUndefined();
    // The binding survives (mode intact) — only the UID pointer moved.
    expect((await reloaded.forProfile("C:\\a.ml"))?.mode).toBe("local");
  });
});

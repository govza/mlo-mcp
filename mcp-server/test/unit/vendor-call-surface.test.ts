import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The steady-state invariant, made grep-provable (spec section 5): the endpoint
 * initiates a vendor call only during initialization — the guarded auto-init
 * pull, or a human's rebind/repull — and never on a timer.
 *
 * A structural test rather than a behavioural one because the property is about
 * what the code CAN do, not what one run happens to do: a new caller of
 * `VendorClient` is a violation the moment it is written, however little it
 * runs. The forwarding path is exempt by construction — it answers MLO's own
 * sessions and never originates one.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

async function sources(): Promise<{ file: string; text: string }[]> {
  const found: { file: string; text: string }[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) {
        found.push({ file: path.relative(SRC, full).replaceAll("\\", "/"), text: await fs.readFile(full, "utf8") });
      }
    }
  }
  await walk(SRC);
  return found;
}

/** Everything that speaks to the vendor as a CLIENT (as opposed to forwarding MLO's own request). */
const VENDOR_CLIENT_CALLS = /\bnew VendorClient\b|\bpullVendorHistory\s*\(/;

describe("the endpoint's vendor-call surface", () => {
  it("is reachable from initialization only", async () => {
    const callers = (await sources())
      .filter(({ text }) => VENDOR_CLIENT_CALLS.test(text))
      .map(({ file }) => file);

    // upstream.ts defines them; auto-init.ts is the one caller — the guarded
    // initialization pull and the repull it services. (A rebind reaches the
    // vendor only by way of the initialization that follows it, and never
    // itself.) Any third file means something else can now call the vendor.
    expect(callers.sort()).toEqual(["cloud/auto-init.ts", "cloud/upstream.ts"]);
  });

  it("has no timer anywhere in the cloud plane", async () => {
    const timers = (await sources())
      .filter(({ file }) => file.startsWith("cloud/"))
      // No interval anywhere in the plane, and no deferred call at all in the
      // two modules that can reach the vendor: a named helper behind a
      // setTimeout would be exactly as periodic as an interval, so the narrow
      // check has to be a total one where it matters.
      .filter(({ file, text }) =>
        /\bsetInterval\s*\(/.test(text) ||
        (/^cloud\/(auto-init|upstream)\.ts$/.test(file) && /\bsetTimeout\s*\(/.test(text)))
      .map(({ file }) => file);

    expect(timers).toEqual([]);
  });
});

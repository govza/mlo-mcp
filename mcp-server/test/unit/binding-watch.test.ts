import { describe, expect, it, vi } from "vitest";
import { watchBindingAppeared, watchBindingChanged } from "../../src/binding-watch.js";

/**
 * A session that composed unbound refuses every write `partition-not-ready`
 * until it dies — even after the user follows the remedy and MLO's proxied
 * sync binds the profile, because the bound stores are resolved once at
 * composition time. This watcher is the fix: poll for the binding, exit
 * cleanly while idle so the client respawns a session that composes bound.
 */

function harness(overrides: {
  probe: () => Promise<boolean>;
  isBusy?: () => boolean;
}) {
  const exit = vi.fn();
  const lines: string[] = [];
  const watcher = watchBindingAppeared({
    probe: overrides.probe,
    isBusy: overrides.isBusy ?? (() => false),
    exit,
    intervalMs: 5,
    log: (line) => lines.push(line),
  });
  return { exit, lines, watcher };
}

const settle = (ticks = 10) => new Promise((resolve) => setTimeout(resolve, ticks * 5));

describe("the binding watcher", () => {
  it("exits once, while idle, when the binding appears", async () => {
    const answers = [false, false, true, true, true];
    const { exit, lines, watcher } = harness({
      probe: async () => answers.shift() ?? true,
    });

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    await settle();
    watcher.stop();

    // Once: the respawn is a single lifecycle event, not a death loop.
    expect(exit).toHaveBeenCalledTimes(1);
    // The session log must explain the exit the way the other watchers do.
    expect(lines.join("\n")).toContain("binding appeared");
  });

  it("defers the exit while the session is busy, then exits on a later idle tick", async () => {
    let busy = true;
    const { exit, watcher } = harness({
      probe: async () => true,
      isBusy: () => busy,
    });

    await settle();
    expect(exit).not.toHaveBeenCalled();

    busy = false;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    watcher.stop();
  });

  it("treats a probe failure as a skipped tick, not a crash or an exit", async () => {
    let calls = 0;
    const { exit, watcher } = harness({
      probe: async () => {
        calls += 1;
        if (calls < 3) throw new Error("state root unreadable mid-write");
        return true;
      },
    });

    // Still polling past the failures, and the failure itself exits nothing.
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    watcher.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("never exits while the profile stays unbound", async () => {
    const { exit, watcher } = harness({ probe: async () => false });

    await settle();
    watcher.stop();

    expect(exit).not.toHaveBeenCalled();
  });
});

describe("the rebind watcher", () => {
  function changedHarness(probe: () => Promise<string | undefined>, isBusy?: () => boolean) {
    const exit = vi.fn();
    const lines: string[] = [];
    const watcher = watchBindingChanged({
      composedUid: "{AAAA}",
      probe,
      isBusy: isBusy ?? (() => false),
      exit,
      intervalMs: 5,
      log: (line) => lines.push(line),
    });
    return { exit, lines, watcher };
  }

  it("exits once when the binding moves to another dataFileUID", async () => {
    const answers: (string | undefined)[] = ["{AAAA}", "{AAAA}", "{BBBB}"];
    const { exit, lines, watcher } = changedHarness(async () => (answers.length ? answers.shift() : "{BBBB}"));

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    await settle();
    watcher.stop();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("{AAAA}");
    expect(lines.join("\n")).toContain("{BBBB}");
  });

  it("a released binding (drift recovery mid-flight) is a move too", async () => {
    const { exit, lines, watcher } = changedHarness(async () => undefined);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    watcher.stop();
    expect(lines.join("\n")).toContain("released");
  });

  it("never exits while the binding stays the composed one", async () => {
    const { exit, watcher } = changedHarness(async () => "{AAAA}");
    await settle();
    watcher.stop();
    expect(exit).not.toHaveBeenCalled();
  });
});

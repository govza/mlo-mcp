import { log as sharedLog } from "./log.js";

/**
 * The third idle-exit watcher (with watchOwnBuild / watchProfileSwitch in the
 * composition root): a session that composed unbound waits for the binding
 * guarded auto-initialization will write once MLO syncs through the endpoint.
 *
 * The bound stores are resolved once at composition time, so a session that
 * started before the first proxied sync refuses every write
 * `partition-not-ready` for its whole life — while `cloud_status`, reading
 * disk fresh, reports the profile bound and ready. The remedy the refusal
 * names ("sync MLO once through the proxy") creates the binding but cannot
 * reach the running process; this watcher is what makes that remedy true.
 * When the probe says bound and the session is idle, exit cleanly so the
 * client respawns a session that composes bound on the next tool call.
 *
 * Armed by the composition root only when the session composed unbound; a
 * bound session has nothing to wait for.
 */
export function watchBindingAppeared(deps: {
  /** Is the profile bound now? The gateway's bound-partition check. */
  probe: () => Promise<boolean>;
  /** Never exit mid-export or mid-write; re-checked every tick. */
  isBusy: () => boolean;
  exit: () => void;
  intervalMs?: number;
  log?: (line: string) => void;
}): { stop: () => void } {
  const { probe, isBusy, exit, intervalMs = 15_000, log = sharedLog } = deps;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (!(await probe()) || isBusy()) return;
      clearInterval(timer);
      log("binding appeared — exiting so the client respawns a session that composes bound");
      exit();
    } catch {
      /* transient probe failure (state root mid-write) — retry next tick */
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * The mirror watcher for a session that composed BOUND: its row store was
 * resolved once, so a drift recovery that rebinds the profile mid-session
 * (template-recreated profile, restored backup) leaves it speaking a dead
 * identity — reads stamp UIDs MLO no longer holds, and writes authored from
 * them import as <Inbox> duplicates. When the binding's dataFileUID moves
 * away from the one this session composed with (or is released), exit cleanly
 * while idle so the client respawns against the current partition.
 */
export function watchBindingChanged(deps: {
  /** The dataFileUID the session's stores were resolved against. */
  composedUid: string;
  /** The binding's current dataFileUID, read fresh off disk. */
  probe: () => Promise<string | undefined>;
  /** Never exit mid-export or mid-write; re-checked every tick. */
  isBusy: () => boolean;
  exit: () => void;
  intervalMs?: number;
  log?: (line: string) => void;
}): { stop: () => void } {
  const { composedUid, probe, isBusy, exit, intervalMs = 15_000, log = sharedLog } = deps;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const current = await probe();
      if (current === composedUid || isBusy()) return;
      clearInterval(timer);
      log(
        `the profile's binding moved (${composedUid} → ${current ?? "released"}) — this session's identity ` +
          "snapshot is stale; exiting so the client respawns against the current partition",
      );
      exit();
    } catch {
      /* transient probe failure (state root mid-write) — retry next tick */
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

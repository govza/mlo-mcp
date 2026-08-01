import { promises as fs } from "node:fs";
import { findSection } from "./csv.js";
import { chooseDriftCandidate, recoverFromDrift, type DriftRecovery } from "./drift-recovery.js";
import type { CloudGateway } from "./gateway.js";
import { normalizeDataFileUid, type PartitionStore } from "./partition.js";
import type { AutoInitRefusalKind, Problem } from "./problem.js";
import { harvestTaskRows } from "./row-store.js";
import { normalizeVendorHistory, pullVendorHistory } from "./upstream.js";
import { taskGuidsInDataFile } from "../guids.js";
import { detectProfile } from "../profile-detect.js";
import { log } from "../log.js";

/**
 * Guarded auto-initialization (spec section 5) — the whole of it, and the ONLY
 * place in the server that initiates a vendor call.
 *
 * Bootstrap is no longer a tool the user runs: after a proxied sync the
 * resident asks itself whether it may bind, and binds if it may. What used to
 * be three blocking guards is now one guard and two recoveries
 * ([ADR-0007](../../../docs/adr/0007-recover-from-sync-drift-automatically.md)):
 *
 * 1. an existing binding for the running app's open profile no longer blocks —
 *    a bound profile with an unclaimed candidate syncing IS the drift fault, so
 *    the abandoned partition is discarded and the binding released
 *    (`recoverFromDrift`);
 * 2. more than one candidate `dataFileUID` no longer blocks either — the most
 *    recently seen is adopted (`chooseDriftCandidate`). Only ZERO candidates
 *    still refuses, because there is nothing to bind to;
 * 3. ground-truthing the candidate against the open data file still runs, and
 *    is still the only check that can catch an adopted-the-wrong-file mistake,
 *    but a refutation now warns instead of refusing.
 *
 * That is a deliberate trade of safety for liveness, argued in ADR-0007: the
 * foreign-profile hazard guards 1 and 2 existed to prevent is now real, and two
 * copies of one profile syncing through the same proxy is the way it bites.
 *
 * Ordering is the other half of the contract, and it is unchanged — it is also
 * what keeps the trade above survivable: **the binding is written last**. Pull,
 * parse-verify, ground-truth and the row-store materialization all happen
 * first, so every partial failure leaves no binding behind and the next proxied
 * sync simply tries again. Recovery follows the same rule: the abandoned
 * partition goes before the pointer moves, so a crash mid-recovery reads as an
 * unbound profile and re-recovers, rather than leaving a stale partition to be
 * adopted a second time. The refusals that remain are typed, and are what a
 * write refuses with while the profile is unbound.
 */

export interface AutoInitRefusal extends Problem {
  kind: AutoInitRefusalKind;
}

export type AutoInitResult =
  | {
      kind: "bound";
      profilePath: string;
      dataFileUID: string;
      tasks: number;
      version: string;
      /** Present when this bind replaced a drifted one (ADR-0007). */
      recovered?: DriftRecovery;
    }
  /** Nothing to do: every cloud file seen syncing is already bound to a profile. */
  | { kind: "already-bound"; dataFileUID?: string }
  | { kind: "refused"; problem: AutoInitRefusal };

/** The pulled full history, as the resident's own vendor client returns it. */
export interface PulledHistory {
  version: string;
  envelope: Buffer;
}

/**
 * Everything auto-init needs from outside the state root, as ports — the pull
 * suite fault-injects each stage by failing one of them.
 */
export interface AutoInitPorts {
  /** The data file the running app actually has open, or undefined when unknowable. */
  openProfile(): Promise<string | undefined>;
  /** Task GUIDs recorded in that data file's own bytes (ground-truth evidence). */
  localTaskGuids(profilePath: string): Promise<string[]>;
  /** The vendor full-history pull. Resident-private: no credential crosses a process seam. */
  pullHistory(uid: string): Promise<PulledHistory>;
}

function refuse(problem: AutoInitRefusal): AutoInitResult {
  return { kind: "refused", problem };
}

/**
 * Does the pulled cloud history describe the profile MLO has open?
 *
 * Overlap is the only sound reading of the two sides. The `.ml` footers are
 * incomplete by construction (cloud-written and recurring tasks have none) and
 * a full history carries tasks the local file has since deleted, so neither
 * side is a superset of the other and no threshold above "shares something"
 * would be honest. The check therefore refutes on exactly one observation: two
 * non-empty sets of task identities with nothing in common — which is what a
 * foreign profile's cloud file looks like, and what nothing else does. An
 * empty side is an unavailable signal and never refutes, the same rule
 * profile detection applies to its own two signals (ADR-0004).
 */
export function groundTruthVerdict(
  localGuids: readonly string[],
  pulledUids: readonly string[],
): { ok: true; overlap: number } | { ok: false; overlap: 0; detail: string } {
  const pulled = new Set(pulledUids);
  let overlap = 0;
  for (const guid of new Set(localGuids)) if (pulled.has(guid)) overlap += 1;
  if (overlap > 0 || !localGuids.length || !pulledUids.length) return { ok: true, overlap };
  return {
    ok: false,
    overlap: 0,
    detail:
      `the pulled cloud history (${pulled.size} tasks) shares no task identity with the open data file ` +
      `(${new Set(localGuids).size} tasks) — it belongs to a different profile`,
  };
}

export class AutoInitializer {
  /** Single-flight: every proxied sync pokes this, and a pull takes seconds. */
  private inFlight: Promise<AutoInitResult> | undefined;

  constructor(
    private readonly gateway: CloudGateway,
    private readonly ports: AutoInitPorts,
  ) {}

  /**
   * Try to initialize, or say why not. Concurrent callers share one attempt;
   * the cheap "nothing is unbound" answer costs no probe and no vendor call,
   * which is what keeps the steady-state invariant at zero endpoint-initiated
   * vendor exchanges.
   */
  attempt(): Promise<AutoInitResult> {
    this.inFlight ??= this.run().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async run(): Promise<AutoInitResult> {
    // Before anything that costs a process or a round trip: in steady state
    // every cloud file the endpoint has seen is already bound, and that answer
    // is in memory. Probing the running app on every proxied sync would spend a
    // PowerShell process per sync to learn nothing.
    const seen = this.gateway.vendorContactUids();
    const candidates: string[] = [];
    for (const uid of seen) {
      if (!(await this.gateway.bindings.forUid(uid))) candidates.push(uid);
    }
    if (seen.length && !candidates.length) return { kind: "already-bound", dataFileUID: seen[0]! };

    const profilePath = await this.ports.openProfile();
    if (!profilePath) {
      return refuse({
        kind: "no-open-profile",
        title: "cannot tell which profile MLO has open, so there is nothing to bind a cloud file to",
        retryable: "after-user-action",
        remedy: "open your profile in MLO, then sync once through the proxy",
      });
    }

    // Guard 2 first, and it is the one guard ADR-0007 keeps: a UID whose sync
    // traffic this process has seen and that no other profile has claimed.
    //
    // Order matters here, and getting it wrong is destructive. Recovery below
    // must never run without a candidate in hand — an endpoint that has seen no
    // traffic at all (MLO closed, or just restarted) reaches this point with a
    // perfectly good binding, and discarding it then would delete a healthy
    // partition for no reason and with nothing to adopt in its place.
    if (!candidates.length) {
      return refuse({
        kind: "no-bootstrap-candidate",
        title: "no vendor sync traffic has been observed since the sync endpoint started",
        retryable: "after-user-action",
        remedy:
          'run one ordinary sync in MLO through this proxy ("Use secure connection" unchecked) so the endpoint ' +
          "sees the cloud file",
      });
    }
    // Ambiguity used to refuse here (`ambiguous-bootstrap-candidate`, still
    // declared in the error contract). ADR-0007 has it choose instead: the most
    // recently seen candidate, checked by ground-truthing below rather than by
    // asking the user which of two identical-looking cloud files is theirs.
    const chosen = chooseDriftCandidate(candidates, await this.gateway.sightings.all().catch(() => []));
    if (candidates.length > 1) {
      log(`${candidates.length} unbound cloud files have synced through this proxy (${candidates.join(", ")}); ` +
        `adopting the most recently seen, ${chosen}`);
    }
    const uid = normalizeDataFileUid(chosen!);

    // Guard 1, now a recovery — and deliberately AFTER a candidate exists. A
    // bound profile with an unclaimed candidate syncing IS the drift fault,
    // never a healthy steady state, so ADR-0007 repairs it here rather than
    // refusing: the abandoned partition and everything queued in it are
    // discarded and the binding released, so the bind below can adopt the
    // identity MLO actually presents.
    const existing = await this.gateway.bindings.forProfile(profilePath);
    let recovered: DriftRecovery | undefined;
    if (existing?.dataFileUID && existing.dataFileUID !== uid) {
      recovered = await recoverFromDrift(this.gateway, profilePath, existing.dataFileUID);
    }

    // The pull and everything derived from it run BEFORE the binding moves.
    let materialized;
    try {
      materialized = await this.pullAndVerify(uid);
    } catch (error) {
      return refuse(pullFailure(uid, error));
    }
    const verdict = groundTruthVerdict(await this.localGuids(profilePath), materialized.uids);
    // ADR-0007: a refuted ground-truth no longer refuses. It is the one check
    // that can catch an adopted-the-wrong-file mistake, so it is still run and
    // still recorded — as the loudest thing the journal carries — but the bind
    // proceeds. The alternative is the state ADR-0007 exists to end: a profile
    // that cannot be written to until a human edits JSON.
    if (!verdict.ok) {
      log(`WARNING: adopting ${uid} for ${profilePath} despite a refuted ground-truth: ${verdict.detail}`);
    }

    const partition = await this.gateway.registry.open(uid, "upstream");
    try {
      await partition.rows.replaceAll(materialized.document, "history-pull");
      await partition.setLifecycle("ready");
    } catch (error) {
      return refuse({
        kind: "auto-init-materialize-failed",
        title:
          `the history for ${uid} pulled cleanly but could not be written to the row store: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
        remedy: "check the endpoint's state root is writable; the next proxied sync retries",
        extensions: { dataFileUID: uid },
      });
    }
    await partition.journal.record(
      verdict.ok ? "ok" : "failed",
      `auto-init: full history at version ${materialized.version} (${materialized.uids.length} tasks)` +
        (recovered
          ? `; recovered from drift — discarded ${recovered.discardedDataFileUID} ` +
            `and ${recovered.discardedWrites} queued write(s)`
          : "") +
        (verdict.ok ? "" : `; GROUND-TRUTH REFUTED, adopted anyway (ADR-0007): ${verdict.detail}`),
    );

    // Last, and only now, and in one write: a binding is the claim that
    // everything above held.
    await this.gateway.bindings.bind(profilePath, "upstream", uid);
    log(`auto-initialized ${profilePath} -> ${uid} at vendor version ${materialized.version} ` +
      `(${materialized.uids.length} tasks, ground-truth overlap ${verdict.overlap})`);
    return {
      kind: "bound",
      profilePath,
      dataFileUID: uid,
      tasks: materialized.uids.length,
      version: materialized.version,
      ...(recovered ? { recovered } : {}),
    };
  }

  /**
   * The whole of the endpoint's own cloud-plane work, run once a proxied
   * session has closed: bind if the guards pass, then service any repull a
   * human asked for. This is the ONE moment the endpoint may talk to the
   * vendor itself, and it never throws — a proxied sync must not be able to
   * notice that any of it happened.
   */
  async serviceAfterSession(rawUid: string | undefined): Promise<void> {
    try {
      const result = await this.attempt();
      if (result.kind === "refused") {
        log(`auto-initialization declined (${result.problem.kind}): ${result.problem.title}`);
      }
      const partition = rawUid ? await this.gateway.registry.resolveExisting(rawUid).catch(() => undefined) : undefined;
      if (partition) await this.servicePendingRepull(partition);
    } catch (error) {
      log(`cloud-plane service failed (sync unaffected): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Service a human's `repull`: refresh the row store from a fresh full
   * history, leaving the binding exactly where it is. The request is left on
   * disk rather than sent, because only the resident can make the vendor call.
   */
  async servicePendingRepull(partition: PartitionStore): Promise<
    { kind: "none" } | { kind: "repulled"; tasks: number; version: string } | { kind: "failed"; problem: AutoInitRefusal }
  > {
    const requestedAt = await partition.repullRequestedAt().catch(() => undefined);
    if (!requestedAt) return { kind: "none" };
    try {
      const materialized = await this.pullAndVerify(partition.uid);
      await partition.rows.replaceAll(materialized.document, "history-pull");
      // Cleared only after the store is whole: a failed repull stays requested,
      // so the next sync retries it instead of leaving a gapped store behind.
      await partition.clearRepullRequest();
      await partition.journal.record(
        "ok",
        `repull: full history at version ${materialized.version} (${materialized.uids.length} tasks)`,
      );
      log(`repulled ${partition.uid} at vendor version ${materialized.version} (${materialized.uids.length} tasks)`);
      return { kind: "repulled", tasks: materialized.uids.length, version: materialized.version };
    } catch (error) {
      const problem = pullFailure(partition.uid, error);
      await partition.journal.record("failed", problem.title).catch(() => undefined);
      return { kind: "failed", problem };
    }
  }

  /** Pull, then prove the payload is a readable history before anything acts on it. */
  private async pullAndVerify(uid: string) {
    const pulled = await this.ports.pullHistory(uid);
    const { document } = normalizeVendorHistory(pulled.envelope);
    const tasks = findSection(document, "TodoItems");
    if (!tasks || !tasks.header.includes("UID")) {
      throw new Error("the pulled history carries no readable TodoItems section");
    }
    const uids = harvestTaskRows(document).rows.map((row) => row.uid);
    return { document, uids, version: pulled.version };
  }

  /** Ground-truth evidence is optional by design: an unreadable `.ml` refutes nothing. */
  private async localGuids(profilePath: string): Promise<string[]> {
    try {
      return await this.ports.localTaskGuids(profilePath);
    } catch (error) {
      log(`could not read task GUIDs from ${profilePath} (ground-truth left unproven): ` +
        `${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}

function pullFailure(uid: string, error: unknown): AutoInitRefusal {
  return {
    kind: "auto-init-pull-failed",
    title:
      `the full-history pull for ${uid} did not complete: ${error instanceof Error ? error.message : String(error)}`,
    // Nothing was bound and nothing was half-written, so the next proxied sync
    // simply tries again — no user action, no cleanup.
    retryable: true,
    remedy: "sync MLO once more through the proxy; the endpoint retries the pull on its own",
    extensions: { dataFileUID: uid },
  };
}

/**
 * The real ports: the running app's own open profile and the endpoint's vendor
 * client. Kept beside the initializer rather than in it so the pull suite can
 * substitute each stage.
 */
export function systemAutoInitPorts(gateway: CloudGateway, mloExePath: string): AutoInitPorts {
  return {
    async openProfile() {
      const verdict = await detectProfile(mloExePath);
      return verdict.ok ? verdict.dataFile : undefined;
    },
    async localTaskGuids(profilePath) {
      return taskGuidsInDataFile(await fs.readFile(profilePath));
    },
    async pullHistory(uid) {
      const contact = gateway.vendorContact(uid);
      if (!contact) {
        throw new Error(`no vendor contact for ${uid} — the endpoint has seen no sync traffic for it since it started`);
      }
      const pulled = await pullVendorHistory(contact, uid, (record) => gateway.noteVendorExchange(record));
      return { version: pulled.version.toString(), envelope: pulled.envelope };
    },
  };
}

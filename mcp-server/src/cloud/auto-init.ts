import { promises as fs } from "node:fs";
import { findSection } from "./csv.js";
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
 * resident asks itself whether it may bind, and binds if it may. Three guards
 * stand between an observed sync and a binding:
 *
 * 1. no binding exists for the running app's open profile (rebinding stays
 *    explicit, `AdminService.rebind`);
 * 2. exactly one candidate `dataFileUID` has synced through the proxy;
 * 3. the candidate ground-truths against that open data file — the pulled
 *    history and the `.ml` on disk must be describing the same tasks.
 *
 * Guard 3 is what kills the foreign-profile hazard: another profile syncing
 * through the same endpoint is a lone candidate too, and nothing before the
 * pull can tell the two apart.
 *
 * Ordering is the other half of the contract: **the binding is written last**.
 * Pull, parse-verify, ground-truth and the row-store materialization all
 * happen first, so every partial failure leaves no binding behind and the next
 * proxied sync simply tries again. A failed guard is a typed refusal naming
 * it, which is also what a write refuses with while the profile is unbound.
 */

export interface AutoInitRefusal extends Problem {
  kind: AutoInitRefusalKind;
}

export type AutoInitResult =
  | { kind: "bound"; profilePath: string; dataFileUID: string; tasks: number; version: string }
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

    // Guard 1. A bound profile is never re-bound behind the user's back: a
    // rebind changes which history owns the profile, so it stays a human act.
    const existing = await this.gateway.bindings.forProfile(profilePath);
    if (existing?.dataFileUID) {
      // Reached only with an unclaimed candidate in hand (the pre-check above),
      // so this profile is bound to one cloud file while another is syncing —
      // the binding-mismatch fault, never a healthy steady state.
      return refuse({
        kind: "binding-conflict",
        title:
          `this profile is bound to ${existing.dataFileUID}, but the sync traffic seen through the proxy is for ` +
          `${seen.join(", ")} — auto-initialization never moves an existing binding`,
        retryable: "after-user-action",
        remedy: "rebind explicitly (the current binding is backed up first) if the new cloud file is the right one",
        extensions: { boundDataFileUID: existing.dataFileUID, observedDataFileUIDs: seen },
      });
    }

    // Guard 2. Exactly one candidate: a UID whose sync traffic this process has
    // seen and that no other profile has claimed (resolved above).
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
    if (candidates.length > 1) {
      return refuse({
        kind: "ambiguous-bootstrap-candidate",
        title: `${candidates.length} unbound cloud files have synced through this proxy (${candidates.join(", ")})`,
        retryable: "after-user-action",
        remedy: "sync only the target profile, restart the sync endpoint, and sync once more",
        extensions: { candidates },
      });
    }
    const uid = normalizeDataFileUid(candidates[0]!);

    // The pull and everything derived from it run BEFORE the binding moves.
    let materialized;
    try {
      materialized = await this.pullAndVerify(uid);
    } catch (error) {
      return refuse(pullFailure(uid, error));
    }
    const verdict = groundTruthVerdict(await this.localGuids(profilePath), materialized.uids);
    if (!verdict.ok) {
      return refuse({
        kind: "candidate-not-ground-truthed",
        title: `${uid} did not ground-truth against ${profilePath}: ${verdict.detail}`,
        retryable: "after-user-action",
        remedy:
          "make sure the profile MLO has open is the one whose cloud file synced through this proxy, then sync again",
        extensions: { dataFileUID: uid, profilePath },
      });
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
      "ok",
      `auto-init: full history at version ${materialized.version} (${materialized.uids.length} tasks)`,
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

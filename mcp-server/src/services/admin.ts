import type { MloConfig } from "../types.js";
import type { BindingMismatch, CloudGateway } from "../cloud/gateway.js";
import type { UnboundSighting } from "../cloud/sightings.js";
import type { EndpointStatus, ResidentEndpoint } from "../cloud/endpoint.js";
import type { PartitionStore } from "../cloud/partition.js";
import type { MloRepository } from "../repo/mlo-repository.js";
import { backupDataFile } from "../cloud/profile-backup.js";
import { failureFor, type AdminFailureKind } from "../error-contract.js";
import { failed, ok, type Failure, type ServiceResult } from "../result.js";

/** The cloud plane's closed failure union (spec section 6). */
export type AdminFailure = Failure & { kind: AdminFailureKind };

function adminFailure(kind: AdminFailureKind, detail: string, remedy?: string): AdminFailure {
  return failureFor(kind, detail, remedy);
}

/**
 * A write that left the queue without landing. Named after where its rows went
 * (the dead-letter file) rather than after its status, because the two states
 * that get here — expired and superseded — differ in cause but not in what the
 * caller lost.
 */
export interface DeadLetter {
  writeId: string;
  uid: string;
  caption?: string;
  status: "expired" | "superseded";
  at: string;
  /** The write path's own words for why the rows never landed. */
  reason?: string;
}

/**
 * The write-path aggregate (spec section 2): the only surface for outcomes
 * nobody is waiting on. A `writeId` receipt dies with the ephemeral MCP session
 * that took it, so a write that expired after the caller went away has no other
 * way to be seen.
 */
export interface WriteAggregate {
  pendingWrites: number;
  /** Age of the oldest queued write, in milliseconds — a queue that is not draining shows up here first. */
  oldestPendingAgeMs?: number;
  /** Most recent first, newest N only: an old dead letter is one nobody is coming back for. */
  recentDeadLetters: DeadLetter[];
  /**
   * Delivery is stalled: MLO took writes into a sync session and has not
   * resolved it, which in practice means a conflict dialog is waiting on the
   * user (spec section 6). Absent when the endpoint is unreachable or too old
   * to report it — unknown, not "no".
   */
  sessionHeldOpen?: boolean;
}

/** How many dead letters `cloud_status` carries. */
const DEAD_LETTER_TAIL = 5;

export interface CloudPlaneStatus {
  host: string;
  port: number;
  endpoint: { url: string; reachable: boolean; version?: string };
  /** "unbound" before bootstrap, or the bound partition's mode. */
  mode: string;
  lifecycle?: string;
  dataFileUID?: string;
  mismatch?: BindingMismatch;
  /** A repull the resident has not serviced yet — outstanding, not failed. */
  repullRequestedAt?: string;
  unboundSightings: UnboundSighting[];
  /** Empty-but-present while unbound: there is no queue, so there is nothing pending. */
  writes: WriteAggregate;
  stateRoot: string;
  partitions: { key: string; mode: string; lifecycle: string }[];
}

export interface RebindOutcome {
  /** Where the profile's `.ml` was copied before the binding was dropped. */
  backup: string;
  /** The UID the profile was bound to, if it was bound at all. */
  previousDataFileUID?: string;
}

export interface RepullOutcome {
  dataFileUID: string;
  requestedAt: string;
}

/**
 * The cloud plane's service (spec section 3): `status()` (gauge-derived as the
 * gauges land), `rebind()`, `repull()`, plus the QuickSync surface.
 *
 * Neither `rebind` nor `repull` talks to the vendor, and neither asks the
 * resident to. Only the resident holds the captured contact and its HTTP
 * surface is closed (spec section 4), so both verbs express themselves in the
 * shared state the resident already reads on every proxied sync: a repull
 * leaves a request on the partition, and a rebind drops the binding, which is
 * exactly the condition guarded auto-initialization waits for. The vendor call
 * stays a private act of the resident either way.
 *
 * Interim layer deviation, on purpose: it holds `CloudGateway` and
 * `ResidentEndpoint` directly until the cloud plane gets its repository-tier
 * homes. It is the ONLY service allowed to — the spec's "no service ever learns
 * a resident exists" rule lands with those tickets.
 */
export class AdminService {
  constructor(
    private readonly config: MloConfig,
    private readonly repo: MloRepository,
    private readonly gateway: CloudGateway,
    private readonly endpoint: ResidentEndpoint
  ) {}

  /**
   * Drop this profile's cloud binding so the endpoint binds it afresh — the
   * remedy when MLO is syncing a cloud file the profile is not bound to.
   *
   * The `.ml` is backed up FIRST and the copy's failure aborts the whole verb:
   * rebinding is the one endpoint operation whose blast radius reaches the
   * user's own data (a wrong new binding delivers writes into a history MLO
   * never reads). The old partition directory is left intact as evidence; only
   * the pointer moves. Re-binding then happens on the next proxied sync, under
   * the same three guards as a first-run initialization — a rebind is explicit
   * about discarding, never about what to adopt next.
   *
   * When the discarded cloud file keeps syncing too, the endpoint then sees two
   * candidates and refuses `ambiguous-bootstrap-candidate` rather than guess.
   * Its remedy — sync only the target profile and restart the endpoint, which
   * forgets the contacts it has seen — is what completes such a rebind. That
   * refusal is the design (ADR-0002: report a mismatch, never repair it), not
   * a gap in it.
   */
  rebind(): Promise<ServiceResult<RebindOutcome, AdminFailure>> {
    return this.overCloudState(async () => {
      const existing = await this.gateway.bindings.forProfile(this.config.dataFile);
      if (!existing?.dataFileUID) {
        // Refused rather than treated as a no-op: a backup copy of the profile
        // per call is real clutter, and "nothing was bound" is what the caller
        // needs to hear anyway.
        return failed(
          adminFailure(
            "nothing-bound",
            "this profile is not bound to a cloud file, so there is nothing to rebind",
            "run one sync in MLO through this proxy first, so auto-initialization binds the profile",
          ),
        );
      }
      let backup: string;
      try {
        backup = await backupDataFile(this.config.dataFile);
      } catch (error) {
        // The copy's failure aborts the whole verb: the binding is what protects
        // the user's data from a wrong new one, and dropping it uncopied is the
        // one ordering this verb may never take.
        return failed(
          adminFailure(
            "backup-failed",
            `the profile could not be copied aside, so the binding was left alone: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            `check that ${this.config.dataFile} is readable and its directory writable, then rebind again`,
          ),
        );
      }
      await this.gateway.bindings.unbindUid(this.config.dataFile);
      return ok({ backup, previousDataFileUID: existing.dataFileUID });
    });
  }

  /**
   * Ask for the row store to be rebuilt from a fresh full-history pull — the
   * remedy an `unknown-row` refusal names. The binding is not touched: this
   * repairs a gap in what the endpoint has captured, it does not reconsider
   * which cloud file the profile belongs to.
   *
   * The pull itself happens in the resident after MLO's next sync, so the
   * answer here is "requested", not "done"; `cloud_status` reports the result
   * through the partition's capture journal.
   */
  repull(): Promise<ServiceResult<RepullOutcome, AdminFailure>> {
    return this.overCloudState(async () => {
      const bound = await this.gateway.boundPartition(this.config.dataFile);
      if (bound.kind !== "bound") {
        return failed(
          adminFailure(
            "partition-not-ready",
            "this profile has no bound cloud partition, so there is no row store to refresh",
            "sync MLO once through the proxy and let the endpoint bind it first",
          ),
        );
      }
      const requestedAt = new Date().toISOString();
      await bound.partition.requestRepull(requestedAt);
      return ok({ dataFileUID: bound.partition.uid, requestedAt });
    });
  }

  /** Run the profile's QuickSync — a best-effort accelerator, never load-bearing (spec section 2.5). */
  async quickSync(): Promise<ServiceResult<void, AdminFailure>> {
    const nudged = await this.repo.quickSync();
    if (nudged.isErrored) {
      return failed(adminFailure("quick-sync-failed", nudged.failure.detail, nudged.failure.remedy));
    }
    return ok(undefined);
  }

  status(): Promise<ServiceResult<CloudPlaneStatus, AdminFailure>> {
    return this.overCloudState(async () => ok(await this.readStatus()));
  }

  /**
   * Every verb here reads or writes the cloud state root, and a state root
   * that cannot be read is an op refusal like any other: this session keeps
   * serving reads, and the next call is fresh.
   */
  private async overCloudState<T>(
    run: () => Promise<ServiceResult<T, AdminFailure>>,
  ): Promise<ServiceResult<T, AdminFailure>> {
    try {
      return await run();
    } catch (error) {
      return failed(
        adminFailure(
          "cloud-state-unreadable",
          `could not read the cloud state root: ${error instanceof Error ? error.message : String(error)}`,
          `check that ${this.gateway.stateRoot} is readable`,
        ),
      );
    }
  }

  private async readStatus(): Promise<CloudPlaneStatus> {
    // Probed rather than remembered: the resident process can exit between two
    // tool calls, and "is it up" is the whole question this field answers.
    const endpointStatus = await this.endpoint.status();
    const endpoint = {
      url: this.endpoint.url,
      reachable: endpointStatus !== undefined,
      ...(endpointStatus?.version ? { version: endpointStatus.version } : {}),
    };

    let mode = "unbound";
    let lifecycle: string | undefined = "uninitialized";
    let dataFileUID: string | undefined;
    let repullRequestedAt: string | undefined;
    let writes: WriteAggregate = { pendingWrites: 0, recentDeadLetters: [] };
    const bound = await this.gateway.boundPartition(this.config.dataFile);
    if (bound.kind === "bound") {
      mode = bound.binding.mode;
      lifecycle = bound.lifecycle;
      dataFileUID = bound.binding.dataFileUID;
      repullRequestedAt = await bound.partition.repullRequestedAt();
      writes = await this.writeAggregate(bound.partition, endpointStatus);
    }
    const partitions = (await this.gateway.registry.list()).map((partition) => ({
      key: partition.key,
      mode: partition.mode,
      lifecycle: partition.lifecycle,
    }));
    // Reported beside the bound UID, never instead of it: the binding is
    // what the server acts on, the sighting is what the app actually syncs.
    const [unboundSightings, mismatch] = await Promise.all([
      this.gateway.unboundSightings(),
      this.gateway.bindingMismatch(this.config.dataFile),
    ]);

    return {
      host: this.config.cloudHost,
      port: this.config.cloudPort,
      endpoint,
      mode,
      lifecycle,
      dataFileUID,
      mismatch,
      ...(repullRequestedAt ? { repullRequestedAt } : {}),
      unboundSightings,
      writes,
      stateRoot: this.gateway.stateRoot,
      partitions,
    };
  }

  /**
   * The write aggregate. The partition's own handle derives what is outstanding
   * and what it lost; this adds the one fact that lives in neither the queue nor
   * the outcome ring — whether MLO is holding a session open over the writes
   * right now, which only the resident can see.
   */
  private async writeAggregate(
    partition: PartitionStore,
    endpointStatus: EndpointStatus | undefined,
  ): Promise<WriteAggregate> {
    const gauge = await partition.writeGauge(DEAD_LETTER_TAIL);
    return {
      pendingWrites: gauge.pendingWrites,
      ...(gauge.oldestPendingAgeMs !== undefined ? { oldestPendingAgeMs: gauge.oldestPendingAgeMs } : {}),
      recentDeadLetters: gauge.deadLetters.map((dead) => ({
        writeId: dead.writeId,
        uid: dead.uid,
        ...(dead.caption ? { caption: dead.caption } : {}),
        status: dead.status,
        at: dead.at,
        ...(dead.detail ? { reason: dead.detail } : {}),
      })),
      ...(endpointStatus?.writesHeldOpen ? { sessionHeldOpen: endpointStatus.writesHeldOpen.length > 0 } : {}),
    };
  }
}

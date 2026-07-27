import type { MloConfig } from "../types.js";
import type { BindingMismatch, CloudGateway } from "../cloud/gateway.js";
import type { UnboundSighting } from "../cloud/sightings.js";
import type { ResidentEndpoint } from "../cloud/endpoint.js";
import type { MloRepository } from "../repo/mlo-repository.js";

export interface CloudPlaneStatus {
  host: string;
  port: number;
  endpoint: { url: string; reachable: boolean; version?: string };
  /** "unbound" before bootstrap, or the bound partition's mode. */
  mode: string;
  lifecycle?: string;
  dataFileUID?: string;
  mismatch?: BindingMismatch;
  unboundSightings: UnboundSighting[];
  stateRoot: string;
  partitions: { key: string; mode: string; lifecycle: string }[];
}

/**
 * The cloud plane's service (spec section 3): today `status()` (gauge-derived
 * as the gauges land) plus the QuickSync surface; `rebind()`/`repull()` and
 * the guarded auto-init arrive with ticket 09.
 *
 * Interim layer deviation, on purpose: it holds `CloudGateway` and
 * `ResidentEndpoint` directly until PartitionStore (ticket 05) and the
 * `ResidentClient` driver inside the repository (ticket 06) give the cloud
 * plane its repository-tier homes. It is the ONLY service allowed to — the
 * spec's "no service ever learns a resident exists" rule lands with those
 * tickets.
 */
export class AdminService {
  constructor(
    private readonly config: MloConfig,
    private readonly repo: MloRepository,
    private readonly gateway: CloudGateway,
    private readonly endpoint: ResidentEndpoint
  ) {}

  /** Run the profile's QuickSync — a best-effort accelerator, never load-bearing (spec section 2.5). */
  quickSync(): Promise<void> {
    return this.repo.quickSync();
  }

  async status(): Promise<CloudPlaneStatus> {
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
    const bound = await this.gateway.boundPartition(this.config.dataFile);
    if (bound.kind === "bound") {
      mode = bound.binding.mode;
      lifecycle = bound.lifecycle;
      dataFileUID = bound.binding.dataFileUID;
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
      unboundSightings,
      stateRoot: this.gateway.stateRoot,
      partitions,
    };
  }
}

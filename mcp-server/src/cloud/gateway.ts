import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudState } from "./state.js";
import { BindingStore, type ProfileBinding } from "./binding.js";
import { BootstrapController } from "./bootstrap.js";
import { PartitionRegistry, type PartitionHandle, type PartitionLifecycle, type PartitionMode } from "./partition.js";
import { log } from "../log.js";

/**
 * Routes every cloud-state access — SOAP, /v1, MCP tools, status — to the
 * right storage:
 *
 * - **Legacy mode** (`legacyStateDir` set): the original single delta log.
 *   Used for the repo demo profile and explicit `MLO_CLOUD_STATE_DIR`
 *   overrides. The directory is treated as disposable demo evidence — it can
 *   mix histories (the repo `messages/` provably does) and must never become
 *   a bootstrap baseline for a real profile.
 * - **Partitioned mode** (`stateRoot` set): per-`dataFileUID` partitions under
 *   a private root outside the checkout. SOAP requests must carry a valid
 *   `dataFileUID` to be routed; `/v1` calls may address a partition explicitly
 *   or fall back to the session default.
 */
export interface CloudGatewayOptions {
  stateRoot?: string;
  legacyStateDir?: string;
  defaultMode: PartitionMode;
}

export class CloudGateway {
  readonly registry?: PartitionRegistry;
  readonly bindings?: BindingStore;
  readonly bootstrap?: BootstrapController;
  readonly legacyState?: CloudState;
  readonly stateRoot?: string;
  readonly legacyStateDir?: string;
  readonly defaultMode: PartitionMode;
  private unboundState?: CloudState;
  private rootPrepared = false;

  constructor(options: CloudGatewayOptions) {
    this.defaultMode = options.defaultMode;
    if (options.legacyStateDir) {
      this.legacyStateDir = options.legacyStateDir;
      this.legacyState = new CloudState(options.legacyStateDir);
    } else if (options.stateRoot) {
      this.stateRoot = options.stateRoot;
      this.registry = new PartitionRegistry(options.stateRoot, options.defaultMode);
      this.bindings = new BindingStore(options.stateRoot);
      this.bootstrap = new BootstrapController(options.stateRoot);
    } else {
      throw new Error("CloudGateway requires either a stateRoot or a legacyStateDir");
    }
  }

  get partitioned(): boolean {
    return this.registry !== undefined;
  }

  /** Where the sync observer writes its structural summaries. */
  observerDir(): string {
    return this.legacyStateDir ?? this.stateRoot!;
  }

  /**
   * Default state for callers that address no specific partition: the legacy
   * log, or a placeholder "unbound" log under the private root. The unbound
   * log exists so `/v1/status` (the attach probe) and tools keep a stable
   * shape before a profile is bound; it is never routed to by SOAP.
   */
  defaultState(): CloudState {
    if (this.legacyState) return this.legacyState;
    this.unboundState ??= new CloudState(path.join(this.stateRoot!, "unbound"));
    return this.unboundState;
  }

  /**
   * The partition bound to a profile, or a description of why none is. Legacy
   * mode reports itself as such — the legacy log is demo evidence, exempt
   * from binding and lifecycle gating.
   */
  async boundPartition(profilePath: string): Promise<
    | { kind: "legacy"; state: CloudState }
    | { kind: "unbound"; binding?: ProfileBinding }
    | { kind: "bound"; binding: ProfileBinding; partition: PartitionHandle; lifecycle: PartitionLifecycle }
  > {
    if (this.legacyState) return { kind: "legacy", state: this.legacyState };
    const binding = await this.bindings!.forProfile(profilePath);
    if (!binding?.dataFileUID) return { kind: "unbound", binding };
    await this.prepareRoot();
    const partition = await this.registry!.open(binding.dataFileUID);
    return { kind: "bound", binding, partition, lifecycle: await partition.lifecycle() };
  }

  /** Resolve the state for a `/v1` call with an optional `dataFileUID`. */
  async stateForV1(rawUid: string | undefined): Promise<CloudState> {
    if (rawUid === undefined) return this.defaultState();
    if (this.legacyState) return this.legacyState;
    await this.prepareRoot();
    const partition = await this.registry!.open(rawUid);
    return partition.state;
  }

  /**
   * Create the private state root on first use, restricting it to the current
   * user. Node has no native Windows ACL API, so this is a best-effort
   * `icacls` call; failure only logs — the root still works, with inherited
   * per-user `%LOCALAPPDATA%` permissions in the default location.
   */
  async ensureRoot(): Promise<void> {
    return this.prepareRoot();
  }

  private async prepareRoot(): Promise<void> {
    if (this.rootPrepared || !this.stateRoot) return;
    this.rootPrepared = true;
    let created = false;
    try {
      await fs.mkdir(this.stateRoot, { recursive: false });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await fs.mkdir(this.stateRoot, { recursive: true });
        created = true;
      }
    }
    if (created && process.platform === "win32") {
      const user = process.env.USERNAME ?? os.userInfo().username;
      execFile(
        "icacls",
        [this.stateRoot, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`],
        (error) => {
          if (error) log(`could not restrict state root ACL (non-fatal): ${error.message}`);
        },
      );
    }
  }
}

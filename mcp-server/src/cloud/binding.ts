import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeDataFileUid, type PartitionMode } from "./partition.js";

/**
 * Persisted, explicit profile→partition bindings.
 *
 * A profile is never bound to "the last dataFileUID seen": the UID is attached
 * only through an explicit bootstrap flow, and every conflicting combination
 * fails closed. A binding's mode never changes silently — switching authority
 * (local replacement server vs vendor upstream) is a rebind plus a fresh
 * partition and re-bootstrap, because the two cursor namespaces cannot be
 * reconciled after the fact.
 */
export interface ProfileBinding {
  /** The configured `.ml` path as given (canonicalized only for comparison). */
  profilePath: string;
  mode: PartitionMode;
  /** Absent until a bootstrap binds the partition. */
  dataFileUID?: string;
  boundAt?: string;
  createdAt: string;
}

interface BindingsFile {
  bindings: ProfileBinding[];
}

/** NTFS is case-insensitive; bindings must not duplicate on spelling. */
function canonicalProfilePath(profilePath: string): string {
  return path.resolve(profilePath).toLowerCase();
}

export class BindingStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly stateRoot: string) {}

  private file(): string {
    return path.join(this.stateRoot, "bindings.json");
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockDir = path.join(this.stateRoot, ".bindings-lock");
    const deadline = Date.now() + 10_000;
    await fs.mkdir(this.stateRoot, { recursive: true });
    for (;;) {
      try {
        await fs.mkdir(lockDir);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(lockDir);
          if (Date.now() - stat.mtimeMs > 30_000) {
            await fs.rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for bindings lock: ${lockDir}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => this.withLock(operation);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<ProfileBinding[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(), "utf8")) as BindingsFile;
      return parsed.bindings ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    }
  }

  private async save(bindings: ProfileBinding[]): Promise<void> {
    const target = this.file();
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(temporary, `${JSON.stringify({ bindings }, null, 2)}\n`);
    await fs.rename(temporary, target);
  }

  async forProfile(profilePath: string): Promise<ProfileBinding | undefined> {
    const canonical = canonicalProfilePath(profilePath);
    return (await this.load()).find((binding) => canonicalProfilePath(binding.profilePath) === canonical);
  }

  async forUid(rawUid: string): Promise<ProfileBinding | undefined> {
    const uid = normalizeDataFileUid(rawUid);
    return (await this.load()).find((binding) => binding.dataFileUID === uid);
  }

  /** Create (or return) the binding for a profile. Mode conflicts fail closed. */
  async create(profilePath: string, mode: PartitionMode): Promise<ProfileBinding> {
    return this.serialize(async () => {
      const bindings = await this.load();
      const canonical = canonicalProfilePath(profilePath);
      const existing = bindings.find((binding) => canonicalProfilePath(binding.profilePath) === canonical);
      if (existing) {
        if (existing.mode !== mode) {
          throw new Error(
            `profile is already bound in "${existing.mode}" mode; switching modes requires an explicit rebind with a fresh partition (cloud_bootstrap { rebind: true })`,
          );
        }
        return existing;
      }
      const binding: ProfileBinding = { profilePath, mode, createdAt: new Date().toISOString() };
      bindings.push(binding);
      await this.save(bindings);
      return binding;
    });
  }

  /** Attach a dataFileUID to a profile's binding. All conflicts fail closed. */
  async bindUid(profilePath: string, rawUid: string): Promise<ProfileBinding> {
    return this.serialize(async () => {
      const uid = normalizeDataFileUid(rawUid);
      const bindings = await this.load();
      const canonical = canonicalProfilePath(profilePath);
      const binding = bindings.find((entry) => canonicalProfilePath(entry.profilePath) === canonical);
      if (!binding) throw new Error(`no binding exists for profile ${profilePath}; create one first`);
      if (binding.dataFileUID && binding.dataFileUID !== uid) {
        throw new Error(
          `profile is already bound to a different dataFileUID; rebinding requires an explicit fresh bootstrap (cloud_bootstrap { rebind: true })`,
        );
      }
      const other = bindings.find((entry) => entry !== binding && entry.dataFileUID === uid);
      if (other) {
        throw new Error(`dataFileUID is already bound to a different profile (${other.profilePath})`);
      }
      binding.dataFileUID = uid;
      binding.boundAt = new Date().toISOString();
      await this.save(bindings);
      return binding;
    });
  }

  /**
   * Drop a profile's UID binding as part of an explicit rebind. The old
   * partition directory is left intact as evidence; only the pointer moves.
   */
  async unbindUid(profilePath: string): Promise<void> {
    await this.serialize(async () => {
      const bindings = await this.load();
      const canonical = canonicalProfilePath(profilePath);
      const binding = bindings.find((entry) => canonicalProfilePath(entry.profilePath) === canonical);
      if (!binding) return;
      delete binding.dataFileUID;
      delete binding.boundAt;
      await this.save(bindings);
    });
  }

  async list(): Promise<ProfileBinding[]> {
    return this.load();
  }
}

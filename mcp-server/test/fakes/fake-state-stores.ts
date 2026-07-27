import path from "node:path";
import type { BindingStore, ProfileBinding } from "../../src/cloud/binding.js";
import type { DeadLetter, DeadLetterStore } from "../../src/cloud/dead-letter.js";
import type { SightingStore, UnboundSighting } from "../../src/cloud/sightings.js";
import { normalizeDataFileUid, type PartitionMode } from "../../src/cloud/partition.js";

/**
 * Trivial in-memory fakes for the small stores beside PartitionStore (spec
 * section 8). Each implements the public surface of its file-backed original
 * (structurally, via Omit of the classes' own fields), so the contract suite
 * can run the same assertions against both.
 */

export type BindingStoreApi = Omit<BindingStore, "stateRoot">;
export type SightingStoreApi = Omit<SightingStore, "stateRoot">;
export type DeadLetterStoreApi = Omit<DeadLetterStore, "stateRoot">;

function canonicalProfilePath(profilePath: string): string {
  return path.resolve(profilePath).toLowerCase();
}

export class FakeBindingStore implements BindingStoreApi {
  private bindings: ProfileBinding[] = [];

  private find(profilePath: string): ProfileBinding | undefined {
    const canonical = canonicalProfilePath(profilePath);
    return this.bindings.find((binding) => canonicalProfilePath(binding.profilePath) === canonical);
  }

  async forProfile(profilePath: string): Promise<ProfileBinding | undefined> {
    return this.find(profilePath);
  }

  async forUid(rawUid: string): Promise<ProfileBinding | undefined> {
    const uid = normalizeDataFileUid(rawUid);
    return this.bindings.find((binding) => binding.dataFileUID === uid);
  }

  async create(profilePath: string, mode: PartitionMode): Promise<ProfileBinding> {
    const existing = this.find(profilePath);
    if (existing) {
      if (existing.mode !== mode) {
        throw new Error(
          `profile is already bound in "${existing.mode}" mode; switching modes requires an explicit rebind with a fresh partition`,
        );
      }
      return existing;
    }
    const binding: ProfileBinding = { profilePath, mode, createdAt: new Date().toISOString() };
    this.bindings.push(binding);
    return binding;
  }

  async bindUid(profilePath: string, rawUid: string): Promise<ProfileBinding> {
    const uid = normalizeDataFileUid(rawUid);
    const binding = this.find(profilePath);
    if (!binding) throw new Error(`no binding exists for profile ${profilePath}; create one first`);
    if (binding.dataFileUID && binding.dataFileUID !== uid) {
      throw new Error(`profile is already bound to a different dataFileUID; rebinding requires an explicit fresh bootstrap`);
    }
    const other = this.bindings.find((entry) => entry !== binding && entry.dataFileUID === uid);
    if (other) throw new Error(`dataFileUID is already bound to a different profile (${other.profilePath})`);
    binding.dataFileUID = uid;
    binding.boundAt = new Date().toISOString();
    return binding;
  }

  async replace(profilePath: string, mode: PartitionMode): Promise<ProfileBinding> {
    const binding: ProfileBinding = { profilePath, mode, createdAt: new Date().toISOString() };
    const index = this.bindings.findIndex(
      (entry) => canonicalProfilePath(entry.profilePath) === canonicalProfilePath(profilePath),
    );
    if (index >= 0) this.bindings[index] = binding;
    else this.bindings.push(binding);
    return binding;
  }

  async unbindUid(profilePath: string): Promise<void> {
    const binding = this.find(profilePath);
    if (!binding) return;
    delete binding.dataFileUID;
    delete binding.boundAt;
  }

  async list(): Promise<ProfileBinding[]> {
    return [...this.bindings];
  }
}

export class FakeSightingStore implements SightingStoreApi {
  private sightings: UnboundSighting[] = [];

  constructor(private readonly max = 8) {}

  async all(): Promise<UnboundSighting[]> {
    return [...this.sightings];
  }

  async note(uid: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.sightings.find((sighting) => sighting.dataFileUID === uid);
    if (existing) {
      existing.lastSeen = now;
      existing.count += 1;
    } else {
      this.sightings.push({ dataFileUID: uid, firstSeen: now, lastSeen: now, count: 1 });
    }
    this.sightings.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    this.sightings = this.sightings.slice(0, this.max);
  }
}

export class FakeDeadLetterStore implements DeadLetterStoreApi {
  private refused: DeadLetter[] = [];

  constructor(private readonly max = 50) {}

  file(): string {
    return "<in-memory dead-letter store>";
  }

  async all(): Promise<DeadLetter[]> {
    return [...this.refused];
  }

  async record(letter: DeadLetter): Promise<void> {
    this.refused = [...this.refused, letter].slice(-this.max);
  }
}

import type { CloudGateway } from "./gateway.js";
import { normalizeDataFileUid } from "./partition.js";
import type { UnboundSighting } from "./sightings.js";
import { log } from "../log.js";

/**
 * Recovery from identity drift ([ADR-0007](../../../docs/adr/0007-recover-from-sync-drift-automatically.md)).
 *
 * Identity drift is the bound profile syncing under a `dataFileUID` other than the one
 * its binding names — a re-created `.ml`, a restore from backup, a
 * Re-synchronize, a reset sync profile. The identity the binding points at stops
 * existing, and because the binding is keyed by path it survives the identity it
 * described. Everything downstream then works perfectly against a partition the
 * app will never read again: writes queue, `sync` answers `{ok:true}`, reads
 * flag the write `pending`, and 15 minutes later the row expires.
 *
 * ADR-0002 chose to refuse those writes and leave the repair to a human.
 * ADR-0007 reverses that: MCP must not sit broken waiting to be repaired by
 * hand, so the endpoint discards the abandoned partition and adopts the identity
 * MLO is actually presenting. The trade is recorded in the ADR — this can adopt
 * the wrong cloud file when two copies of a profile sync through the same proxy,
 * and it is deliberately silent about what the discarded queue held.
 *
 * The two halves live apart so the choice can be tested without a state root:
 * `chooseDriftCandidate` decides, `recoverFromDrift` effects.
 */

/** What one recovery threw away and what it adopted, for the log and the journal. */
export interface DriftRecovery {
  profilePath: string;
  /** The identity the binding named, whose partition has now been deleted. */
  discardedDataFileUID: string;
  /** Writes that were still queued in it. Discarded, not dead-lettered, not replayed. */
  discardedWrites: number;
}

/**
 * Which unbound candidate to adopt.
 *
 * One candidate is the whole of the ordinary case. More than one is the hazard
 * ADR-0002 refused outright: nothing before a pull can tell a second copy of
 * this profile from the real one. Recovery still has to answer, so it takes the
 * most recently seen — the identity whose sync traffic is freshest is the one
 * the running app is most likely presenting. Ground-truthing downstream is what
 * turns that from a guess into a checked guess; a candidate absent from the
 * sightings sorts last rather than being dropped, because a UID seen only as an
 * in-memory vendor contact is still a real candidate.
 */
export function chooseDriftCandidate(
  candidates: readonly string[],
  sightings: readonly UnboundSighting[],
): string | undefined {
  if (candidates.length <= 1) return candidates[0];
  const lastSeen = new Map(sightings.map((sighting) => [sighting.dataFileUID, Date.parse(sighting.lastSeen)]));
  return [...candidates].sort((a, b) => (lastSeen.get(b) ?? -Infinity) - (lastSeen.get(a) ?? -Infinity))[0];
}

/**
 * Discard the abandoned partition and release the binding, so the caller's
 * ordinary bind path can adopt the live identity.
 *
 * Ordering mirrors auto-initialization's: the destructive step runs first and
 * the pointer moves last, so a failure part-way leaves a binding pointing at a
 * partition that is already gone — which reads as an unbound profile and
 * recovers on the next sync — rather than a binding pointing at nothing while
 * the stale partition survives to be adopted again.
 */
export async function recoverFromDrift(
  gateway: CloudGateway,
  profilePath: string,
  boundRawUid: string,
): Promise<DriftRecovery> {
  const boundUid = normalizeDataFileUid(boundRawUid);
  const abandoned = await gateway.registry.resolveExisting(boundUid).catch(() => undefined);
  const discardedWrites = abandoned ? (await abandoned.queue.pending().catch(() => [])).length : 0;
  await gateway.registry.discard(boundUid);
  await gateway.bindings.unbindUid(profilePath);
  log(
    `drift recovery: ${profilePath} was bound to ${boundUid}, which MLO no longer syncs — ` +
      `partition discarded (${discardedWrites} queued write(s) dropped), binding released`,
  );
  return { profilePath, discardedDataFileUID: boundUid, discardedWrites };
}

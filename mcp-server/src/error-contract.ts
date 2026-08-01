/**
 * The one table of failure kinds ([spec section 6](../../docs/adr/0005-target-architecture-spec.md)).
 *
 * Every kind this build can produce is declared here once, with its
 * blast-radius tier, its producer-declared `retryable`, and — for the two
 * tiers that outlive a single call — the observation that ends it. The review
 * gates the spec asks for are executable against this table
 * (`test/unit/error-contract.test.ts`): no kind sits outside the four tiers,
 * every Event- and write-gate-tier kind names its ending observation, and
 * every kind named by a boundary union appears here.
 *
 * Boundary unions are declared here too, as kind-name arrays the boundaries
 * derive their union types from. That is what keeps a union and this table
 * from drifting apart: a new kind is a new table row or it does not typecheck.
 */

import type { Retryable } from "./cloud/problem.js";

/**
 * The four blast radii. Nothing may sit outside them, and post-startup nothing
 * stops the server: `startup-verdict` is the only tier allowed to exit.
 */
export const BLAST_RADII = ["event", "op-refusal", "write-gate", "startup-verdict"] as const;
export type BlastRadius = (typeof BLAST_RADII)[number];

export interface KindContract {
  tier: BlastRadius;
  retryable: Retryable;
  /** What this kind means, in the terms the tier table uses. */
  meaning: string;
  /**
   * The observation that ends the condition. Required for `event` and
   * `write-gate` kinds — those persist past the call that produced them, so a
   * kind with no stated end is a latch nobody knows how to clear.
   */
  endedBy?: string;
  /**
   * The standing remedy for kinds whose ending is the caller's own next move
   * rather than an observation to wait for. Every kind declares one or the
   * other, so no failure ever reaches a caller with its meaning restated as
   * advice; a producer with something more specific to say passes its own.
   */
  remedy?: string;
}

// ---------------------------------------------------------------- the table

export const ERROR_CONTRACT = {
  // --- Event: journaled and visible in cloud_status; blocks nothing --------
  "capture-failed": {
    tier: "event",
    retryable: true,
    meaning: "a proxied sync exchange could not be captured into the row store",
    endedBy: "the next proxied sync captures ok — health is a window over the journal, never a stored verdict",
  },
  "capture-skipped": {
    tier: "event",
    retryable: true,
    meaning: "an exchange carried nothing worth capturing, or arrived for a partition that is not bound",
    endedBy: "the next proxied sync captures ok",
  },
  "tls-connect-seen": {
    tier: "event",
    retryable: false,
    meaning: "MLO opened a CONNECT tunnel, so the exchange inside it is opaque to capture",
    endedBy: "MLO syncs over the plain proxied route again, which the next capture records",
  },
  "unbound-sighting": {
    tier: "event",
    retryable: false,
    meaning: "a dataFileUID synced through the endpoint with no binding to any profile",
    endedBy: "auto-initialization binds that UID, or an explicit rebind adopts it",
  },
  "write-expired": {
    tier: "event",
    retryable: "after-user-action",
    meaning: "an accepted row was never carried by an Apply before its TTL; the caller's words are dead-lettered",
    endedBy: "the caller re-issues the write once MLO is syncing again — nothing re-delivers it automatically",
  },
  "injection-skipped": {
    tier: "event",
    retryable: true,
    meaning: "a Get carried queued rows but composing the enriched payload failed, so the vendor's own answer went through verbatim",
    endedBy: "the next Get composes and carries the rows — the queue keeps them until an Apply confirms or the TTL expires",
  },
  "queue-redelivery": {
    tier: "event",
    retryable: true,
    meaning: "a session ended without resolving rows it carried, so they were unpinned for the next Get",
    endedBy: "MLO's Apply confirms the row, or the write expires at TTL",
  },
  "version-skew-attach": {
    tier: "event",
    retryable: false,
    meaning: "a session attached to a resident from a different build",
    endedBy: "the newer session replaces the resident, which is the one path that leaves something listening",
  },
  "write-superseded": {
    tier: "event",
    retryable: false,
    meaning: "MLO uploaded a different row for the same UID: the user answered the conflict dialog local-wins",
    endedBy: "nothing to clear — the user's own answer is the end state; re-author if the change is still wanted",
  },

  // --- Op refusal: this call returns isErrored; the next is fresh ----------
  "snapshot-unavailable": {
    tier: "op-refusal",
    retryable: true,
    meaning: "the profile could not be exported and parsed right now (mlo.exe busy, locked, or failing)",
    remedy: "ask again in a moment — MLO refuses to export while a dialog or another operation holds the profile",
  },
  "target-unresolvable": {
    tier: "op-refusal",
    retryable: false,
    meaning: "a path id names no task in this snapshot, or the task carries no recoverable GUID",
    remedy: "re-run list_tasks — path ids shift when the tree changes — or make this change in the MLO app",
  },
  "unknown-row": {
    tier: "op-refusal",
    retryable: "after-user-action",
    meaning: "the row store has never captured the target's full row, so a rewrite would blank what it omits",
    remedy: "repull, so the row store is rebuilt from a fresh full-history pull",
  },
  "unsupported-edit": {
    tier: "op-refusal",
    retryable: false,
    meaning: "the edit would bypass behaviour only the MLO app performs (recurrence generation)",
    remedy: "make this change in the MLO app instead",
  },
  "invalid-request": {
    tier: "op-refusal",
    retryable: false,
    meaning: "the call contradicts itself before anything is authored (empty batch, duplicate key, unknown context)",
    remedy: "fix the call and issue it again — nothing was authored",
  },
  "endpoint-down": {
    tier: "op-refusal",
    retryable: true,
    meaning: "no resident answered the write seam; nothing was spooled",
    remedy: "call again — the next call re-attaches, spawning a resident if the port is free",
  },
  "unknown-write": {
    tier: "op-refusal",
    retryable: false,
    meaning: "the resident holds no receipt under this writeId",
    remedy: "check the writeId; a receipt older than the outcome ring is one nobody is coming back for",
  },
  "quick-sync-failed": {
    tier: "op-refusal",
    retryable: true,
    meaning: "the best-effort sync accelerator failed; delivery still rides MLO's own cadence",
    remedy: "nothing has to be done — queued rows still reach the app on MLO's own sync cadence",
  },
  "cloud-state-unreadable": {
    tier: "op-refusal",
    retryable: true,
    meaning: "the cloud state root could not be read for this call",
    remedy: "check that the state root exists and is readable, then call again",
  },
  "backup-failed": {
    tier: "op-refusal",
    retryable: true,
    meaning: "the profile could not be copied aside, so the verb that needed the copy did nothing",
    remedy: "check that the profile is readable and its directory writable, then call the verb again",
  },
  "nothing-bound": {
    tier: "op-refusal",
    retryable: false,
    meaning: "the verb needs a bound partition and this profile has none",
    remedy: "sync MLO once through the proxy so auto-initialization can bind the profile",
  },
  "auto-init-pull-failed": {
    tier: "op-refusal",
    retryable: true,
    meaning: "a bootstrap attempt's full-history pull failed; no binding was written",
    remedy: "sync MLO through the proxy again — the next sync re-attempts the pull from nothing",
  },
  "auto-init-materialize-failed": {
    tier: "op-refusal",
    retryable: true,
    meaning: "a bootstrap attempt pulled but could not materialize or verify the row store; no binding was written",
    remedy: "sync MLO through the proxy again — the next sync re-attempts the whole bootstrap from nothing",
  },
  unknown: {
    tier: "op-refusal",
    retryable: false,
    meaning: "a refusal this build does not recognize, kept verbatim rather than lost (newer resident, or a proxy)",
    remedy: "read the carried title and wire type; a newer resident may be serving this build's port",
  },

  // --- Write gate: every write refuses the same way until state changes ----
  "partition-not-ready": {
    tier: "write-gate",
    retryable: "after-user-action",
    meaning: "this profile has no bound cloud partition, so there is nowhere to author against",
    endedBy: "one proxied sync from MLO through the endpoint, which is what guarded auto-initialization waits for",
  },
  "binding-mismatch": {
    tier: "write-gate",
    retryable: "after-user-action",
    // Declared and never produced. The gate ADR-0002 specified was never built,
    // and ADR-0007 removed the need for one: drift is now recovered from
    // automatically, so there is no standing mismatch left to refuse on. Kept
    // beside the others so the tier table stays complete.
    meaning: "MLO is syncing a dataFileUID other than the bound one, so writes would land where the app never reads",
    endedBy: "an explicit rebind, then one proxied sync that binds the UID MLO actually presents",
  },
  "no-open-profile": {
    tier: "write-gate",
    retryable: "after-user-action",
    meaning: "the running app exposes no open data file, so no candidate can be ground-truthed",
    endedBy: "MLO opens the profile again; the next proxied sync re-runs the guards",
  },
  "binding-conflict": {
    tier: "write-gate",
    retryable: "after-user-action",
    meaning: "the candidate UID is already bound to another profile",
    endedBy: "an explicit rebind of whichever profile should give up the UID",
  },
  "no-bootstrap-candidate": {
    tier: "write-gate",
    retryable: "after-user-action",
    meaning: "the endpoint has seen no cloud file sync that could be this profile",
    endedBy: "one proxied sync from MLO, which gives the endpoint its candidate",
  },
  // Both declared and no longer produced: ADR-0007 has auto-initialization
  // choose the most recently sighted candidate rather than refuse, and warn on a
  // refuted ground-truth rather than refuse. Kept for the complete tier table.
  "ambiguous-bootstrap-candidate": {
    tier: "write-gate",
    retryable: "after-user-action",
    meaning: "more than one cloud file synced through the endpoint, and adopting the wrong one is unrecoverable",
    endedBy: "sync only the target profile and restart the endpoint, which forgets the contacts it has seen",
  },
  "candidate-not-ground-truthed": {
    tier: "write-gate",
    retryable: "after-user-action",
    meaning: "the candidate's task identities do not overlap the running app's open data file",
    endedBy: "sync the profile MLO actually has open, so its own cloud file becomes the candidate",
  },

  // --- Startup verdict: refuse to start, exit 1 — before serving only ------
  // The three detection refusals (ADR-0006). The first two are definite — the
  // running app has no usable profile open, or not ours — and a live session
  // exits on them. The third is "we could not tell", which never cycles one.
  "profile-not-open": {
    tier: "startup-verdict",
    retryable: "after-user-action",
    meaning: "the app has no saved profile open to serve — it is not running, or its outline was never saved",
    remedy: "open the profile in MLO (saving it first if it is new), then start the server again",
  },
  "profile-contradicted": {
    tier: "startup-verdict",
    retryable: "after-user-action",
    meaning: "the app's own signals disagree about which profile it has open, or two instances hold different ones",
    remedy: "reopen the profile you want to work in from MLO, leaving one instance running",
  },
  "profile-undetectable": {
    tier: "startup-verdict",
    retryable: true,
    meaning: "which profile the app has open could not be established — the probe failed or MLO's log was unreadable",
    remedy: "re-enable MLO's logging if it was turned off, reopen the profile, and start the server again",
  },
  "port-conflict": {
    tier: "startup-verdict",
    retryable: "after-user-action",
    meaning: "a foreign listener holds the resident's port, and overwriting it would take MLO's sync down",
    remedy: "free the port, or point MLO's proxy and this server at one that is free",
  },
} as const satisfies Record<string, KindContract>;

export type ContractKind = keyof typeof ERROR_CONTRACT;

/**
 * The one failure builder every boundary uses. Producers supply the detail —
 * what happened, in this call's terms — and the table supplies everything the
 * contract owns: the tier's `retryable` and the standing remedy. A producer
 * with something more specific to say passes its own remedy; nothing restates
 * the table by hand, so the table cannot quietly stop being the truth.
 */
export function failureFor<K extends ContractKind>(
  kind: K,
  detail: string,
  remedy?: string,
): { kind: K; retryable: Retryable; remedy: string; detail: string } {
  const declared = ERROR_CONTRACT[kind] as KindContract;
  return {
    kind,
    retryable: declared.retryable,
    remedy: remedy ?? declared.remedy ?? declared.endedBy ?? declared.meaning,
    detail,
  };
}

// ------------------------------------------------------------ the boundaries

/**
 * Repository tier (spec section 6: "repositories return infra kinds"). The
 * resident's own problem+json kinds are infra kinds too, so they cross the
 * seam under their own names rather than collapsing into one opaque wrapper.
 */
export const REPO_FAILURE_KINDS = [
  "snapshot-unavailable",
  "endpoint-down",
  "quick-sync-failed",
  "unknown-write",
  "invalid-request",
  "partition-not-ready",
  "no-open-profile",
  "binding-conflict",
  "no-bootstrap-candidate",
  "ambiguous-bootstrap-candidate",
  "candidate-not-ground-truthed",
  "auto-init-pull-failed",
  "auto-init-materialize-failed",
  "unknown",
] as const satisfies readonly ContractKind[];

export type RepoFailureKind = (typeof REPO_FAILURE_KINDS)[number];

/** Everything a read service can refuse with. */
export const READ_FAILURE_KINDS = ["snapshot-unavailable", "target-unresolvable"] as const satisfies
  readonly ContractKind[];

export type ReadFailureKind = (typeof READ_FAILURE_KINDS)[number];

/**
 * OutlineService: its own domain kinds plus the infra kinds it forwards by
 * name. Forwarding beats re-wrapping — a caller reading `binding-conflict`
 * gets the remedy that ends it, where a generic `write-refused` would have
 * buried it one level down.
 */
export const OUTLINE_FAILURE_KINDS = [
  "target-unresolvable",
  "unknown-row",
  "unsupported-edit",
  ...REPO_FAILURE_KINDS,
] as const satisfies readonly ContractKind[];

export type OutlineFailureKind = (typeof OUTLINE_FAILURE_KINDS)[number];

/** AdminService: the cloud plane's verbs. */
export const ADMIN_FAILURE_KINDS = [
  "nothing-bound",
  "backup-failed",
  "partition-not-ready",
  "cloud-state-unreadable",
  "quick-sync-failed",
] as const satisfies readonly ContractKind[];

export type AdminFailureKind = (typeof ADMIN_FAILURE_KINDS)[number];

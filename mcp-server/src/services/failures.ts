/**
 * The service tier's side of the error contract (spec section 6): the domain
 * kinds every service maps its repository's infra kinds into, built once here
 * so two services cannot phrase the same refusal differently.
 */

import { failureFor, type OutlineFailureKind, type ReadFailureKind } from "../error-contract.js";
import type { Failure } from "../result.js";

/** A path id that names no row a write could target. */
export type TargetUnresolvable = Failure & { kind: "target-unresolvable"; id: string };

/** Everything a read can refuse with: the export failed, or the id was not there. */
export type ReadFailure = (Failure & { kind: ReadFailureKind }) | TargetUnresolvable;

/**
 * Everything a write can refuse with: OutlineService's own domain kinds plus
 * the infra kinds it forwards under their own names (`error-contract.ts`).
 * The forwarding needs no mapping step — a repository failure IS one of these
 * already, which is the point of naming the infra kinds in the union.
 */
export type OutlineFailure =
  | TargetUnresolvable
  | (Failure & { kind: "unknown-row"; uid: string })
  | (Failure & { kind: OutlineFailureKind });

export function unresolvable(id: string, detail: string): TargetUnresolvable {
  return { ...failureFor("target-unresolvable", detail), id };
}

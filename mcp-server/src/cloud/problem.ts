/**
 * RFC 9457 problem+json across the session↔resident seam (spec section 6).
 *
 * The `kind` is the contract; the HTTP status stays meaningful but decorative.
 * Class identity dies at the HTTP seam, so refusals are plain tagged objects
 * on both sides: the resident serializes one of these, the session client
 * rehydrates it and never throws on a refusal. An unrecognized `type`
 * rehydrates as `{ kind: "unknown" }` — degraded, never lost.
 */

export const PROBLEM_TYPE_PREFIX = "urn:mlo-mcp:";
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export type Retryable = boolean | "after-user-action";

export interface Problem {
  kind: string;
  title: string;
  retryable: Retryable;
  /** What ends the condition — caller metadata, never an automatic retry. */
  remedy?: string;
  /** Kind-specific typed fields, carried as RFC 9457 extension members. */
  extensions?: Record<string, unknown>;
}

/**
 * The guarded auto-initialization refusals (spec section 5): a write into an
 * unbound profile refuses with the guard that stopped the binding, never a
 * generic "not ready". Declared here, where the wire contract lives, so the
 * union and the set of kinds the session recognizes cannot drift apart.
 */
export const AUTO_INIT_REFUSAL_KINDS = [
  "no-open-profile",
  "binding-conflict",
  "no-bootstrap-candidate",
  "ambiguous-bootstrap-candidate",
  "candidate-not-ground-truthed",
  "auto-init-pull-failed",
  "auto-init-materialize-failed",
] as const;

export type AutoInitRefusalKind = (typeof AUTO_INIT_REFUSAL_KINDS)[number];

/**
 * The kinds this build's resident can serialize. The session client treats
 * anything outside this set as `unknown`, which is what lets a newer resident
 * introduce a kind without crashing older sessions.
 */
export const RESIDENT_PROBLEM_KINDS: ReadonlySet<string> = new Set([
  "invalid-request",
  "partition-not-ready",
  "unknown-write",
  ...AUTO_INIT_REFUSAL_KINDS,
]);

export function problemBody(problem: Problem): string {
  return JSON.stringify({
    type: `${PROBLEM_TYPE_PREFIX}${problem.kind}`,
    title: problem.title,
    retryable: problem.retryable,
    ...(problem.remedy ? { remedy: problem.remedy } : {}),
    ...problem.extensions,
  });
}

/** A refusal as the session side holds it after rehydration. */
export interface RehydratedProblem {
  kind: string;
  title: string;
  retryable: Retryable;
  remedy?: string;
  /** The wire `type` verbatim — kept so an `unknown` kind stays diagnosable. */
  type?: string;
  status: number;
  extensions: Record<string, unknown>;
}

function asRetryable(value: unknown): Retryable {
  return value === true || value === false || value === "after-user-action" ? value : false;
}

const CARRIER_FIELDS = new Set(["type", "title", "retryable", "remedy", "status", "detail", "instance"]);

/**
 * Rehydrate one non-2xx resident response. Never throws: a body that is not
 * problem+json at all (a crashed resident, a proxy in the middle) degrades to
 * `kind: "unknown"` with whatever text is available as the title.
 */
export function parseProblem(
  status: number,
  bodyText: string,
  knownKinds: ReadonlySet<string> = RESIDENT_PROBLEM_KINDS,
): RehydratedProblem {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(bodyText) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    /* not JSON — degrade below */
  }
  if (!parsed) {
    return {
      kind: "unknown",
      title: bodyText.slice(0, 200) || `resident answered HTTP ${status}`,
      retryable: false,
      status,
      extensions: {},
    };
  }
  const type = typeof parsed.type === "string" ? parsed.type : undefined;
  const kind = type?.startsWith(PROBLEM_TYPE_PREFIX) ? type.slice(PROBLEM_TYPE_PREFIX.length) : undefined;
  const title = typeof parsed.title === "string" && parsed.title.length
    ? parsed.title
    : `resident answered HTTP ${status}`;
  const extensions: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!CARRIER_FIELDS.has(name)) extensions[name] = value;
  }
  if (!kind || !knownKinds.has(kind)) {
    return {
      kind: "unknown",
      title,
      retryable: asRetryable(parsed.retryable),
      ...(type ? { type } : {}),
      status,
      extensions,
    };
  }
  return {
    kind,
    title,
    retryable: asRetryable(parsed.retryable),
    ...(typeof parsed.remedy === "string" ? { remedy: parsed.remedy } : {}),
    ...(type ? { type } : {}),
    status,
    extensions,
  };
}

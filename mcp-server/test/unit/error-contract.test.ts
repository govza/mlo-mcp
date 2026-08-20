import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_FAILURE_KINDS,
  BLAST_RADII,
  ERROR_CONTRACT,
  failureFor,
  OUTLINE_FAILURE_KINDS,
  READ_FAILURE_KINDS,
  REPO_FAILURE_KINDS,
  type ContractKind,
} from "../../src/error-contract.js";
import { RESIDENT_PROBLEM_KINDS } from "../../src/cloud/problem.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

async function sourceFiles(dir = SRC): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/**
 * The review gates the spec asks for, run as tests (spec section 6). They are
 * the reason the contract table exists as data rather than as prose: a kind
 * with no tier, no ending observation, or no table row fails the build here
 * instead of being noticed in a review — or not.
 */
describe("error contract review gates", () => {
  const entries = Object.entries(ERROR_CONTRACT) as [ContractKind, (typeof ERROR_CONTRACT)[ContractKind]][];

  it("every kind sits in exactly one of the four blast-radius tiers", () => {
    for (const [kind, contract] of entries) {
      expect(BLAST_RADII, `${kind} has a tier outside the four`).toContain(contract.tier);
    }
  });

  it("every Event- and write-gate-tier kind declares the observation that ends it", () => {
    for (const [kind, contract] of entries) {
      if (contract.tier !== "event" && contract.tier !== "write-gate") continue;
      expect(contract.endedBy, `${kind} outlives its call but names nothing that ends it`).toBeTruthy();
    }
  });

  it("every kind declares what ends it: an observation to wait for, or a remedy to act on", () => {
    for (const [kind, contract] of entries) {
      expect(
        contract.endedBy ?? contract.remedy,
        `${kind} has neither — a caller would be handed its meaning restated as advice`,
      ).toBeTruthy();
    }
  });

  it("every kind says what it means, and carries a producer-declared retryable", () => {
    for (const [kind, contract] of entries) {
      expect(contract.meaning.length, `${kind} has no meaning`).toBeGreaterThan(0);
      expect([true, false, "after-user-action"], `${kind} has a bad retryable`).toContain(contract.retryable);
    }
  });

  it("every boundary union names only kinds the table declares", () => {
    const declared = new Set(Object.keys(ERROR_CONTRACT));
    const unions = {
      repository: REPO_FAILURE_KINDS,
      read: READ_FAILURE_KINDS,
      outline: OUTLINE_FAILURE_KINDS,
      admin: ADMIN_FAILURE_KINDS,
      resident: [...RESIDENT_PROBLEM_KINDS],
    };
    for (const [boundary, kinds] of Object.entries(unions)) {
      for (const kind of kinds) expect(declared, `${boundary} names undeclared ${kind}`).toContain(kind);
    }
  });

  it("no table row is dead: op refusals all belong to a boundary union", () => {
    const inAUnion = new Set<string>([
      ...REPO_FAILURE_KINDS,
      ...READ_FAILURE_KINDS,
      ...OUTLINE_FAILURE_KINDS,
      ...ADMIN_FAILURE_KINDS,
    ]);
    for (const [kind, contract] of entries) {
      // Events are journaled rather than returned, and startup verdicts exit
      // before any boundary exists — only op refusals have to be reachable.
      if (contract.tier !== "op-refusal") continue;
      expect(inAUnion, `${kind} is declared but no boundary can produce it`).toContain(kind);
    }
  });

  it("post-startup nothing stops the server: only startup verdicts may exit", () => {
    const exiting = entries.filter(([, contract]) => contract.tier === "startup-verdict").map(([kind]) => kind);
    expect(exiting.sort()).toEqual(["port-conflict", "profile-contradicted", "profile-not-open", "profile-undetectable"]);
  });
});

describe("no automatic retries anywhere", () => {
  it("only the lifecycle watchers hold an interval, and they are not failure paths", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (!/setInterval\s*\(/.test(await fs.readFile(file, "utf8"))) continue;
      // The lifecycle watchers: build/profile-switch (index.ts) and the
      // binding watcher a session that composed unbound arms (binding-watch.ts).
      if (["index.ts", "binding-watch.ts"].includes(path.basename(file))) continue;
      offenders.push(path.relative(SRC, file));
    }
    expect(offenders, "a periodic timer outside the lifecycle watchers is a retry loop in disguise").toEqual([]);
  });

  it("no failure path sleeps and tries again", async () => {
    // `retryable`/`remedy` are caller metadata: the producer says what would
    // end the condition, and the caller decides. The only waits this server
    // performs are lock acquisition, startup port polling, and the bounded
    // delivery wait after a durable accept (outline.ts) — none is a response
    // to a typed failure.
    const waiters = [
      "src/repo/mlo-cli.ts",
      "src/cloud/state-lock.ts",
      "src/cloud/endpoint.ts",
      "src/cloud/server.ts",
      "src/services/outline.ts",
    ];
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const relative = path.relative(path.join(SRC, ".."), file).replace(/\\/g, "/");
      if (waiters.includes(relative)) continue;
      const source = await fs.readFile(file, "utf8");
      if (/setTimeout\s*\(/.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});

describe("failureFor is the only place contract data is stated", () => {
  it("takes retryable and the standing remedy from the table", () => {
    const failure = failureFor("unknown-row", "no captured row for {ABC}");
    expect(failure.retryable).toBe(ERROR_CONTRACT["unknown-row"].retryable);
    expect(failure.remedy).toBe(ERROR_CONTRACT["unknown-row"].remedy);
    expect(failure.detail).toBe("no captured row for {ABC}");
  });

  it("lets a producer say something more specific than the standing remedy", () => {
    expect(failureFor("invalid-request", "duplicate key", "give each task a unique key").remedy)
      .toBe("give each task a unique key");
  });
});

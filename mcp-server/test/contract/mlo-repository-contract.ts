import { describe, it, expect } from "vitest";
import type { DeltaRow, MloRepository } from "../../src/repo/mlo-repository.js";
import { expectFailed, expectOk } from "../expect-result.js";

export interface MloRepositoryHarness {
  repo: MloRepository;
  /** A row this implementation will durably accept. */
  sampleRow(): DeltaRow;
}

/**
 * Parameterized contract every MloRepository implementation must pass (spec
 * section 8): run from `unit` against the fake always, and from `mlo` against
 * the real implementation once the resident write path exists, so the fake
 * cannot drift.
 *
 * Every verb answers a `ServiceResult`: a refusal that throws is a contract
 * violation on either side (spec section 6).
 */
export function describeMloRepositoryContract(
  name: string,
  makeHarness: () => MloRepositoryHarness | Promise<MloRepositoryHarness>
): void {
  describe(`MloRepository contract — ${name}`, () => {
    it("snapshot returns a task tree", async () => {
      const { repo } = await makeHarness();
      const snap = expectOk(await repo.snapshot());
      expect(Array.isArray(snap.tasks)).toBe(true);
    });

    it("write durably accepts and returns a receipt with an expiry", async () => {
      const { repo, sampleRow } = await makeHarness();
      const pending = expectOk(await repo.write([sampleRow()]));
      expect(pending.writeId).toBeTruthy();
      expect(pending.expiresAt).toBeTruthy();
    });

    it("a just-accepted write reads back as accepted, under its own receipt", async () => {
      const { repo, sampleRow } = await makeHarness();
      const { writeId } = expectOk(await repo.write([sampleRow()]));
      const state = expectOk(await repo.status(writeId));
      expect(state.status).toBe("accepted");
      expect(state.writeId).toBe(writeId);
      // Still queued, so the caller can still be told when it gives up.
      expect(state.expiresAt).toBeTruthy();
    });

    it("every accept gets its own writeId — two queued writes can share one uid", async () => {
      const { repo, sampleRow } = await makeHarness();
      const row = sampleRow();
      const first = expectOk(await repo.write([row]));
      const second = expectOk(await repo.write([row]));
      expect(second.writeId).not.toBe(first.writeId);
    });

    it("an unknown receipt is a typed refusal, never a throw", async () => {
      const { repo } = await makeHarness();
      const failure = expectFailed(await repo.status("w-never-issued"));
      expect(failure.kind).toBe("unknown-write");
      expect(failure.remedy).toBeTruthy();
    });
  });
}

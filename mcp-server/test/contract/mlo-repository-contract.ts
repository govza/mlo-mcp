import { describe, it, expect } from "vitest";
import type { DeltaRow, MloRepository } from "../../src/repo/mlo-repository.js";

export interface MloRepositoryHarness {
  repo: MloRepository;
  /** A row this implementation will durably accept. */
  sampleRow(): DeltaRow;
}

/**
 * Parameterized contract every MloRepository implementation must pass (spec
 * section 8): run from `unit` against the fake always, and from `mlo` against
 * the real implementation once the resident write path exists, so the fake
 * cannot drift. Skeleton — typed refusal kinds join with the error-contract
 * ticket.
 */
export function describeMloRepositoryContract(
  name: string,
  makeHarness: () => MloRepositoryHarness | Promise<MloRepositoryHarness>
): void {
  describe(`MloRepository contract — ${name}`, () => {
    it("snapshot returns a task tree", async () => {
      const { repo } = await makeHarness();
      const snap = await repo.snapshot();
      expect(Array.isArray(snap.tasks)).toBe(true);
    });

    it("write durably accepts and returns a receipt with an expiry", async () => {
      const { repo, sampleRow } = await makeHarness();
      const pending = await repo.write([sampleRow()]);
      expect(pending.writeId).toBeTruthy();
      expect(pending.expiresAt).toBeTruthy();
    });

    it("a just-accepted write reads back as accepted", async () => {
      const { repo, sampleRow } = await makeHarness();
      const { writeId } = await repo.write([sampleRow()]);
      expect(await repo.status(writeId)).toBe("accepted");
    });

    it("every accept gets its own writeId — two queued writes can share one uid", async () => {
      const { repo, sampleRow } = await makeHarness();
      const row = sampleRow();
      const first = await repo.write([row]);
      const second = await repo.write([row]);
      expect(second.writeId).not.toBe(first.writeId);
    });
  });
}

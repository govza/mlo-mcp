import { describe, expect, it } from "vitest";
import { buildTaskAddDelta, deltaRowsFromDocument } from "../../src/cloud/delta.js";
import type { DeltaRow } from "../../src/repo/mlo-repository.js";
import type { ResidentClient } from "../../src/repo/resident-client.js";

/**
 * Parameterized contract every ResidentClient must pass (spec section 8): the
 * fake and the HTTP driver answer the same shapes, including typed refusals
 * as VALUES — a refusal that throws is a contract violation on either side.
 */

const UID = "{DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD}";

export function sampleAddRows(uid = UID, caption = "contract add"): DeltaRow[] {
  return deltaRowsFromDocument(buildTaskAddDelta({
    uid,
    caption,
    createdDate: "2026-07-27T10:00:00",
    lastModified: "2026-07-27T10:00:00",
  }));
}

export interface ResidentClientHarness {
  /** A client attached to a working resident with `boundProfile` bound. */
  client: ResidentClient;
  boundProfile: string;
  /** A client that cannot reach any resident at all. */
  downClient(): ResidentClient | Promise<ResidentClient>;
}

export function describeResidentClientContract(
  name: string,
  makeHarness: () => ResidentClientHarness | Promise<ResidentClientHarness>,
): void {
  describe(`ResidentClient contract — ${name}`, () => {
    it("postWrite durably accepts: receipt with writeId, uid, and expiry", async () => {
      const { client, boundProfile } = await makeHarness();
      const result = await client.postWrite({ profile: boundProfile, rows: sampleAddRows() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.writeId).toBeTruthy();
      expect(result.value.uid).toBe(UID);
      expect(Date.parse(result.value.expiresAt)).toBeGreaterThan(Date.now());
    });

    it("every accept gets its own writeId — two queued writes can share one uid", async () => {
      const { client, boundProfile } = await makeHarness();
      const first = await client.postWrite({ profile: boundProfile, rows: sampleAddRows() });
      const second = await client.postWrite({ profile: boundProfile, rows: sampleAddRows() });
      if (!first.ok || !second.ok) throw new Error("both writes must accept");
      expect(second.value.writeId).not.toBe(first.value.writeId);
    });

    it("writeStatus answers accepted for a queued receipt", async () => {
      const { client, boundProfile } = await makeHarness();
      const written = await client.postWrite({ profile: boundProfile, rows: sampleAddRows() });
      if (!written.ok) throw new Error("write must accept");
      const status = await client.writeStatus(written.value.writeId);
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.value.status).toBe("accepted");
      expect(status.value.uid).toBe(UID);
    });

    it("an unknown receipt is the typed unknown-write refusal, never a throw", async () => {
      const { client } = await makeHarness();
      const status = await client.writeStatus("w-never-issued");
      expect(status.ok).toBe(false);
      if (status.ok) return;
      expect(status.refusal.kind).toBe("unknown-write");
      expect(status.refusal.retryable).toBe(false);
    });

    it("rows carrying no task and no tombstone refuse invalid-request", async () => {
      const { client, boundProfile } = await makeHarness();
      const result = await client.postWrite({
        profile: boundProfile,
        rows: [{ section: "Places", values: ["{EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE}", "a place"] }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.kind).toBe("invalid-request");
      expect(result.refusal.retryable).toBe(false);
    });

    it("a resident that answers nothing is the typed retryable endpoint-down refusal — never a spool", async () => {
      const harness = await makeHarness();
      const down = await harness.downClient();
      const result = await down.postWrite({ profile: harness.boundProfile, rows: sampleAddRows() });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.kind).toBe("endpoint-down");
      expect(result.refusal.retryable).toBe(true);
      expect(await down.probe()).toBeUndefined();
    });
  });
}

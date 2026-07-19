import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { createDeltaSkeleton } from "../../src/cloud/delta.js";
import { emitSectionedCsv } from "../../src/cloud/csv.js";
import { packEnvelope, unpackEnvelope } from "../../src/cloud/envelope.js";

describe("cloud envelope", () => {
  it("packs and unpacks data.csv", () => {
    const original = createDeltaSkeleton();
    expect(unpackEnvelope(packEnvelope(original)).sections.map((s) => s.name)).toEqual(original.sections.map((s) => s.name));
  });

  it("rejects non-ZIP and missing data.csv", () => {
    expect(() => unpackEnvelope(new Uint8Array([1, 2, 3]))).toThrow(/invalid ZIP/);
    expect(() => unpackEnvelope(zipSync({ "other.csv": [new Uint8Array(), { level: 6 }] }))).toThrow(/missing data\.csv/);
  });

  it("rejects unsupported FileVersion", () => {
    const delta = createDeltaSkeleton();
    delta.sections[0]!.rows[0]![0] = "4";
    const zip = zipSync({ "data.csv": [emitSectionedCsv(delta), { level: 6 }] });
    expect(() => unpackEnvelope(zip)).toThrow(/FileVersion/);
  });
});

import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { annotateGuids } from "../../src/guids.js";
import type { TaskNode } from "../../src/types.js";

const GUID_PREFIX = Buffer.from([0x64, 0, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0]);

function node(Caption: string, Children: TaskNode[] = []): TaskNode {
  return { id: "", Caption, Places: [], Children, DependsOn: [] } as unknown as TaskNode;
}

function caption(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
}

/** 16 GUID bytes that format back to {AAAAAAAA-...} for a given seed byte. */
function footer(seed: number): Buffer {
  return Buffer.concat([GUID_PREFIX, Buffer.alloc(16, seed)]);
}

function guidOf(seed: number): string {
  const h = seed.toString(16).padStart(2, "0").toUpperCase();
  return `{${h.repeat(4)}-${h.repeat(2)}-${h.repeat(2)}-${h.repeat(2)}-${h.repeat(6)}}`;
}

/** Wrap raw task-record bytes in the .ml container annotateGuids expects. */
function mlFile(raw: Buffer): Buffer {
  const comp = deflateRawSync(raw);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  header.writeUInt32LE(comp.length, 18); // compressed size
  header.writeUInt16LE(0, 26); // filename length
  header.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([Buffer.from("MyLifeDataFile2\0", "utf8"), header, comp]);
}

describe("annotateGuids", () => {
  // Byte layout mirrors the real format: each node writes its caption on entry
  // (pre-order) and its GUID footer after its children (post-order).
  it("assigns each node its own GUID and never the invisible root's", () => {
    const raw = Buffer.concat([
      caption("P"),
      caption("A"),
      footer(0xa1),
      caption("B"),
      footer(0xb2),
      footer(0xcc), // P
      footer(0xff), // invisible root
    ]);

    const a = node("A");
    const b = node("B");
    const p = node("P", [a, b]);
    const count = annotateGuids(mlFile(raw), [p]);

    expect(a.Guid).toBe(guidOf(0xa1));
    expect(b.Guid).toBe(guidOf(0xb2));
    expect(p.Guid).toBe(guidOf(0xcc));
    expect(count).toBe(3);
    // the trailing footer belongs to the invisible root: targeting it hangs the CLI
    expect([a.Guid, b.Guid, p.Guid]).not.toContain(guidOf(0xff));
  });

  it("leaves a footerless node blank instead of stealing its parent's GUID", () => {
    // B carries no footer (recurring tasks use a different layout), which
    // desyncs the post-order stream for everything after it.
    const raw = Buffer.concat([
      caption("P"),
      caption("A"),
      footer(0xa1),
      caption("B"),
      footer(0xcc), // P
      footer(0xff), // invisible root
    ]);

    const a = node("A");
    const b = node("B");
    const p = node("P", [a, b]);
    annotateGuids(mlFile(raw), [p]);

    expect(a.Guid).toBe(guidOf(0xa1));
    expect(b.Guid).toBeUndefined(); // must NOT become P's guid
    expect(p.Guid).not.toBe(guidOf(0xff)); // and must NOT cascade onto the root's
    expect(p.Guid).toBe(guidOf(0xcc)); // P still gets its own
  });
});

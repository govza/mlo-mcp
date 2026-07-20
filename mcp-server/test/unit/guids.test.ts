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

  // A last child closes its parent (and any further ancestors it ends), so all
  // of them share one end bound and their footers all fall in that one window.
  // That chain is the unit that has to balance; a node short of a footer makes
  // every order-preserving assignment in the chain equally consistent with the
  // bytes, so none of them may be trusted.
  describe("a chain short of a footer", () => {
    it("assigns nothing when the missing footer is the innermost node's", () => {
      // The delta-add shape: B was written through the cloud sync and carries a
      // caption but no footer yet. The regression: B took P's footer.
      const raw = Buffer.concat([
        caption("P"),
        caption("A"),
        footer(0xa1),
        caption("B"), // no footer of its own
        footer(0xcc), // P
        caption("Q"),
        footer(0xdd), // Q
        footer(0xff), // invisible root
      ]);

      const a = node("A");
      const b = node("B");
      const p = node("P", [a, b]);
      const q = node("Q");
      annotateGuids(mlFile(raw), [p, q]);

      expect(a.Guid).toBe(guidOf(0xa1)); // its own chain balances, unaffected
      expect(b.Guid).toBeUndefined(); // must NOT take P's
      expect(p.Guid).toBeUndefined(); // 0xcc could be B's or P's — unknowable
      expect(q.Guid).toBe(guidOf(0xdd)); // later chains still resync
    });

    it("assigns nothing when the missing footer is the outermost node's", () => {
      // The recurring-task shape, mirror image of the case above: P is the one
      // serialized without a footer and 0xb2 belongs to its last child B. Which
      // way round it is cannot be read out of the bytes, so the two cases must
      // resolve identically — in particular P must never inherit B's GUID.
      const raw = Buffer.concat([
        caption("P"), // recurring: no footer of its own
        caption("A"),
        footer(0xa1),
        caption("B"),
        footer(0xb2), // B
        caption("Q"),
        footer(0xdd), // Q
        footer(0xff), // invisible root
      ]);

      const a = node("A");
      const b = node("B");
      const p = node("P", [a, b]);
      const q = node("Q");
      annotateGuids(mlFile(raw), [p, q]);

      expect(a.Guid).toBe(guidOf(0xa1));
      expect(b.Guid).toBeUndefined();
      expect(p.Guid).not.toBe(guidOf(0xb2)); // must NOT inherit its child's
      expect(p.Guid).toBeUndefined();
      expect(q.Guid).toBe(guidOf(0xdd));
    });

    it("assigns nothing when a whole delta-added subtree has no footers", () => {
      // A re-parented task plus the children added under it leave one footer
      // for a three-node chain — the shape that made "Buy treadmill at sport
      // store" report its grandparent's GUID.
      const raw = Buffer.concat([
        caption("P"),
        caption("NEW"), // delta-added, no footer
        caption("KID"), // delta-added, no footer
        footer(0xcc), // P
        caption("Q"),
        footer(0xdd), // Q
        footer(0xff), // invisible root
      ]);

      const kid = node("KID");
      const nw = node("NEW", [kid]);
      const p = node("P", [nw]);
      const q = node("Q");
      annotateGuids(mlFile(raw), [p, q]);

      expect(kid.Guid).toBeUndefined();
      expect(nw.Guid).toBeUndefined();
      expect(p.Guid).toBeUndefined();
      expect(q.Guid).toBe(guidOf(0xdd));
    });

    it("assigns nothing when a chain holds a node whose caption never matched", () => {
      // B's caption is absent from the binary but its footer is there, so the
      // counts line up by coincidence; trusting them would hand B's 0xb2 to
      // someone else. An unmatched caption also widens its siblings' bounds —
      // A's now reaches Q — so A, B and P form ONE chain and none of them can
      // be trusted. Costs A a GUID it would otherwise have resolved, which is
      // the conservative side to err on.
      const raw = Buffer.concat([
        caption("P"),
        caption("A"),
        footer(0xa1),
        footer(0xb2), // B's, but B's caption was never written
        footer(0xcc), // P
        caption("Q"),
        footer(0xdd), // Q
        footer(0xff), // invisible root
      ]);

      const a = node("A");
      const b = node("B"); // caption not present in raw
      const p = node("P", [a, b]);
      const q = node("Q");
      annotateGuids(mlFile(raw), [p, q]);

      expect(a.Guid).toBeUndefined();
      expect(b.Guid).toBeUndefined();
      expect(p.Guid).toBeUndefined();
      expect(q.Guid).toBe(guidOf(0xdd)); // later chains still resync
    });

    it("assigns nothing when a chain holds more footers than nodes", () => {
      const raw = Buffer.concat([
        caption("P"),
        caption("A"),
        footer(0xa1),
        footer(0xb2), // stray: no node in the chain owns this
        footer(0xcc), // P
        caption("Q"),
        footer(0xdd), // Q
        footer(0xff), // invisible root
      ]);

      const a = node("A");
      const p = node("P", [a]);
      const q = node("Q");
      annotateGuids(mlFile(raw), [p, q]);

      expect(a.Guid).toBeUndefined();
      expect(p.Guid).toBeUndefined();
      expect(q.Guid).toBe(guidOf(0xdd));
    });

    it("never balances the trailing chain with the invisible root's footer", () => {
      // B and P close the file, so their window runs to the root footer. That
      // footer is not assignable, which leaves the chain one short — it must
      // stay empty rather than reach for the root's GUID, which hangs the CLI.
      const raw = Buffer.concat([
        caption("P"),
        caption("A"),
        footer(0xa1),
        caption("B"), // no footer of its own
        footer(0xff), // invisible root
      ]);

      const a = node("A");
      const b = node("B");
      const p = node("P", [a, b]);
      annotateGuids(mlFile(raw), [p]);

      expect(a.Guid).toBe(guidOf(0xa1));
      expect(b.Guid).toBeUndefined();
      expect(p.Guid).toBeUndefined();
      expect([a.Guid, b.Guid, p.Guid]).not.toContain(guidOf(0xff));
    });

    it("makes forward progress through a window holding no footers at all", () => {
      // X is footerless and is not a last child, so its window is empty. The
      // walk has to move past it and still resolve everything after.
      const raw = Buffer.concat([
        caption("P"),
        caption("X"), // no footer, and no footer before Y's caption either
        caption("Y"),
        footer(0xb2), // Y
        footer(0xcc), // P
        caption("Q"),
        footer(0xdd), // Q
        footer(0xff), // invisible root
      ]);

      const x = node("X");
      const y = node("Y");
      const p = node("P", [x, y]);
      const q = node("Q");
      annotateGuids(mlFile(raw), [p, q]);

      expect(x.Guid).toBeUndefined();
      expect(y.Guid).toBe(guidOf(0xb2));
      expect(p.Guid).toBe(guidOf(0xcc));
      expect(q.Guid).toBe(guidOf(0xdd));
    });

    it("assigns nothing when a counted footer precedes the caption it would pair with", () => {
      // The chain [B, P] counts two footers, but 0xxx sits before B's caption,
      // so the pairing is misaligned however well it counts.
      const raw = Buffer.concat([
        caption("P"),
        footer(0x11), // precedes B's caption: cannot be B's
        caption("B"),
        footer(0xcc),
        caption("Q"),
        footer(0xdd), // Q
        footer(0xff), // invisible root
      ]);

      const b = node("B");
      const p = node("P", [b]);
      const q = node("Q");
      annotateGuids(mlFile(raw), [p, q]);

      expect(b.Guid).toBeUndefined();
      expect(p.Guid).toBeUndefined();
      expect(q.Guid).toBe(guidOf(0xdd)); // and the walk still resyncs
    });
  });

  it("keeps an authoritative GUID but still consumes its slot", () => {
    // An IDD carried by the XML export wins over the binary; the footer it
    // would have taken must not fall through to the next node.
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
    a.Guid = guidOf(0x77); // authoritative, not from the binary
    const b = node("B");
    const p = node("P", [a, b]);
    const count = annotateGuids(mlFile(raw), [p]);

    expect(a.Guid).toBe(guidOf(0x77)); // kept
    expect(b.Guid).toBe(guidOf(0xb2)); // did NOT slide onto 0xa1
    expect(p.Guid).toBe(guidOf(0xcc));
    expect(count).toBe(3);
  });
});

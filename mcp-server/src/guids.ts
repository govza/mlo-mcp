import { inflateRawSync } from "node:zlib";
import type { TaskNode } from "./types.js";

/**
 * Recover per-task GUIDs from the .ml binary (they are absent from XML exports).
 *
 * Verified structure (see docs/ml-binary-format.md):
 * - .ml = "MyLifeDataFile2\0" header, then a PK entry ("ZIPDATA") of raw-deflate data.
 * - Inside, task records serialize the tree recursively: each node writes its
 *   caption (uint32-LE length + UTF-8) on entry — pre-order — and a footer
 *   after all of its children — post-order — containing the 16-byte GUID
 *   preceded by the bytes 64 00 00 00 01 00 00 00 00 00 00 00.
 * - Alignment: match captions sequentially in pre-order with a moving cursor,
 *   then assign GUIDs in post-order, constrained to lie inside the node's
 *   (captionOffset, subtreeEndBound) window. Recurring tasks use a different
 *   footer layout and end up without a GUID — callers must handle undefined.
 * - The file's last GUID belongs to the invisible root; it is NOT a valid
 *   -task target (MLO pops a modal Warning and the CLI hangs), so it is
 *   deliberately never assigned.
 */

const GUID_PREFIX = Buffer.from([0x64, 0, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0]);

function inflateDataFile(ml: Buffer): Buffer {
  const zipStart = ml.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (zipStart === -1) throw new Error("not an MLO data file: no ZIP entry found");
  const fnLen = ml.readUInt16LE(zipStart + 26);
  const extraLen = ml.readUInt16LE(zipStart + 28);
  const compSize = ml.readUInt32LE(zipStart + 18);
  const start = zipStart + 30 + fnLen + extraLen;
  return inflateRawSync(ml.subarray(start, start + compSize));
}

function formatGuid(b: Buffer): string {
  const h = (x: number) => x.toString(16).padStart(2, "0");
  return (
    "{" +
    (h(b[3]) + h(b[2]) + h(b[1]) + h(b[0]) + "-" + h(b[5]) + h(b[4]) + "-" + h(b[7]) + h(b[6]) +
      "-" + h(b[8]) + h(b[9]) + "-" + [...b.subarray(10, 16)].map(h).join("")).toUpperCase() +
    "}"
  );
}

interface AlignNode {
  task: TaskNode;
  children: AlignNode[];
  capOff?: number;
  endBound?: number;
}

/**
 * Annotate `tasks` (a freshly exported tree of the SAME data file state) with
 * GUIDs extracted from the raw .ml bytes. Mutates the nodes' Guid field.
 * Returns the number of tasks that received a GUID.
 */
export function annotateGuids(mlFile: Buffer, tasks: TaskNode[]): number {
  const raw = inflateDataFile(mlFile);

  const wrap = (t: TaskNode): AlignNode => ({ task: t, children: t.Children.map(wrap) });
  const roots = tasks.map(wrap);

  const preList: AlignNode[] = [];
  const postList: AlignNode[] = [];
  const walk = (n: AlignNode) => {
    preList.push(n);
    for (const c of n.children) walk(c);
    postList.push(n);
  };
  roots.forEach(walk);

  // 1. sequential pre-order caption match
  let cursor = 0;
  for (const n of preList) {
    const needle = Buffer.from(n.task.Caption, "utf8");
    if (needle.length === 0) continue;
    let idx = raw.indexOf(needle, cursor);
    while (idx !== -1 && (idx < 4 || raw.readUInt32LE(idx - 4) !== needle.length)) {
      idx = raw.indexOf(needle, idx + 1);
    }
    if (idx === -1) continue; // caption not found; node stays GUID-less
    n.capOff = idx;
    cursor = idx + needle.length;
  }

  // 2. subtree end bounds: caption offset of the next pre-order node after the subtree
  for (let i = 0; i < preList.length; i++) {
    const lastDesc = (function last(n: AlignNode): AlignNode {
      return n.children.length ? last(n.children[n.children.length - 1]) : n;
    })(preList[i]);
    const nextIdx = preList.indexOf(lastDesc) + 1;
    let bound = raw.length;
    for (let j = nextIdx; j < preList.length; j++) {
      if (preList[j].capOff !== undefined) {
        bound = preList[j].capOff!;
        break;
      }
    }
    preList[i].endBound = bound;
  }

  // 3. GUID footer offsets
  const guidOffs: number[] = [];
  let g = raw.indexOf(GUID_PREFIX);
  while (g !== -1) {
    guidOffs.push(g + GUID_PREFIX.length);
    g = raw.indexOf(GUID_PREFIX, g + 1);
  }

  // 4. post-order constrained assignment
  let gi = 0;
  let assigned = 0;
  for (const n of postList) {
    if (n.capOff === undefined) continue;
    if (gi < guidOffs.length && guidOffs[gi] > n.capOff && guidOffs[gi] < n.endBound!) {
      // an IDD from the XML export is authoritative — keep it, but still consume the slot
      n.task.Guid ??= formatGuid(raw.subarray(guidOffs[gi], guidOffs[gi] + 16));
      gi++;
      assigned++;
    }
  }
  return assigned;
}

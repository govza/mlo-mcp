import { inflateRawSync } from "node:zlib";
import type { TaskNode } from "./types.js";

/**
 * Recover per-task GUIDs from the .ml binary (they are absent from XML exports).
 *
 * Verified structure (see docs/mlo/ml-binary-format.md):
 * - .ml = "MyLifeDataFile2\0" header, then a PK entry ("ZIPDATA") of raw-deflate data.
 * - Inside, task records serialize the tree recursively: each node writes its
 *   caption (uint32-LE length + UTF-8) on entry — pre-order — and a footer
 *   after all of its children — post-order — containing the 16-byte GUID
 *   preceded by the bytes 64 00 00 00 01 00 00 00 00 00 00 00.
 * - Alignment: match captions sequentially in pre-order with a moving cursor,
 *   then assign GUIDs in post-order. A last child closes its parent and any
 *   further ancestors it ends, so all of them share one subtree end bound and
 *   their footers all fall in that single window; that chain, not the
 *   individual node, is the unit that must balance 1:1 against the footers
 *   inside it. Chains that do not balance are left entirely unassigned —
 *   see step 4 for why no alignment heuristic is sound there.
 * - Nodes therefore routinely end up without a GUID (recurring tasks use a
 *   different footer layout; cloud-delta writes have no footer until MLO
 *   re-serializes them, and they take their whole chain down with them), so
 *   callers must handle undefined.
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
  //
  // The file's last footer belongs to the invisible root: never assignable.
  const assignable = guidOffs.slice(0, -1);
  const rootOff = guidOffs.length ? guidOffs[guidOffs.length - 1] : raw.length;

  // A node closes its whole ancestor chain whenever it is their last
  // descendant, and step 2 hands every node in that chain the SAME end bound —
  // the next caption after the shared subtree. Those nodes are consecutive in
  // post-order and their footers are the ones lying before that bound, so the
  // chain is the unit that has to balance: N nodes must find exactly N footers
  // inside the window. Matching greedily one node at a time instead lets a
  // footerless node swallow its parent's footer and cascade up the chain,
  // because the parent's footer does sit inside the child's (chain-wide)
  // window. This is the general form of the trailing-chain case fixed in
  // e383ccf — that chain is just the one whose bound is the root footer.
  let gi = 0;
  let assigned = 0;
  for (let i = 0; i < postList.length; ) {
    const bound = Math.min(postList[i].endBound!, rootOff);
    let j = i;
    while (j < postList.length && Math.min(postList[j].endBound!, rootOff) === bound) j++;
    const chain = postList.slice(i, j);

    let f = gi;
    while (f < assignable.length && assignable[f] < bound) f++;
    const avail = f - gi;

    // One footer per node means the alignment is determined. Any other count
    // means a node in the chain serialized without one — recurring tasks use a
    // different footer layout, and a task written through the cloud delta gets
    // a caption but no footer until MLO re-serializes it — and nothing in the
    // bytes says WHICH node that is: for a delta-added subtree it is the
    // innermost, for a recurring parent it is the outermost, and every
    // order-preserving assignment of k footers to n>k nested nodes is equally
    // consistent with the file. So assign none rather than guess. A blank GUID
    // just falls back to the cloud delta log; a wrong one silently retargets
    // writes and deletes at another task's subtree.
    //
    // A caption that did not match anywhere leaves the same ambiguity from the
    // other side — the node is still in the chain and may still own one of the
    // footers — so a chain holding one is never trusted either, however neatly
    // the counts happen to line up.
    // Every node must also sit before the footer it would take; a footer that
    // precedes its own caption means the chain is misaligned however well it
    // counts, and then none of it can be trusted either.
    const aligned =
      avail === chain.length &&
      chain.every((n, k) => n.capOff !== undefined && assignable[gi + k] > n.capOff);

    if (aligned) {
      chain.forEach((n, k) => {
        // an IDD from the XML export is authoritative — keep it, but still consume the slot
        n.task.Guid ??= formatGuid(raw.subarray(assignable[gi + k], assignable[gi + k] + 16));
        assigned++;
      });
    }
    gi = f; // resync past this chain's window either way
    i = j;
  }
  return assigned;
}

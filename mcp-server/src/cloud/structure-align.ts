import { rowValue, resolveTaskUid, type KnownCloudProjection } from "./log-projection.js";
import { log } from "../log.js";
import type { TaskNode } from "../types.js";

/**
 * Task identity by STRUCTURAL alignment.
 *
 * The authoritative tree is built from the materialized cloud rows —
 * `UID`/`ParentUID` for shape, numeric `ItemIndex` for sibling order (an
 * ordering key, not an array position). The fresh XML export outline is then
 * aligned against it: when a parent slot has the same number of children on
 * both sides, children pair by position with caption equality as a veto;
 * when the counts differ (drift mid-write), only children whose caption is
 * unique within BOTH sibling lists pair up. Everything else stays unresolved
 * — fail closed rather than guess.
 *
 * Caption-path matching cannot be the identity authority because duplicate
 * sibling captions are legal and real; binary `.ml` GUID recovery is a
 * cross-check only (its chain alignment deliberately skips nodes).
 */
export interface AlignedIdentity {
  byPathId: Map<string, string>;
  confidence: Map<string, "positional" | "caption-unique">;
}

interface CloudNode {
  uid: string;
  caption: string;
  itemIndex: number;
  children: CloudNode[];
}

function buildCloudTree(projection: KnownCloudProjection): CloudNode[] {
  const nodes = new Map<string, CloudNode>();
  for (const [uid, known] of projection.rows) {
    const index = Number(rowValue(known, "ItemIndex"));
    nodes.set(uid, {
      uid,
      caption: rowValue(known, "Caption"),
      itemIndex: Number.isFinite(index) ? index : Number.MAX_SAFE_INTEGER,
      children: [],
    });
  }
  const roots: CloudNode[] = [];
  for (const [uid, known] of projection.rows) {
    const node = nodes.get(uid)!;
    const parent = rowValue(known, "ParentUID").toUpperCase();
    const parentNode = parent ? nodes.get(parent) : undefined;
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }
  const sortSiblings = (siblings: CloudNode[]): void => {
    siblings.sort((a, b) => a.itemIndex - b.itemIndex); // stable: ties keep row order
    for (const node of siblings) sortSiblings(node.children);
  };
  sortSiblings(roots);
  return roots;
}

function alignSiblings(
  exportChildren: readonly TaskNode[],
  cloudChildren: readonly CloudNode[],
  identity: AlignedIdentity,
): void {
  let pairs: [TaskNode, CloudNode][] = [];
  let positional = exportChildren.length === cloudChildren.length;
  if (positional) {
    for (let index = 0; index < exportChildren.length; index++) {
      if (exportChildren[index]!.Caption !== cloudChildren[index]!.caption) {
        positional = false;
        break;
      }
    }
  }
  if (positional) {
    pairs = exportChildren.map((task, index) => [task, cloudChildren[index]!]);
  } else {
    // Drifted slot: pair only captions unique on both sides.
    const countBy = (captions: readonly string[]) => {
      const counts = new Map<string, number>();
      for (const caption of captions) counts.set(caption, (counts.get(caption) ?? 0) + 1);
      return counts;
    };
    const exportCounts = countBy(exportChildren.map((task) => task.Caption));
    const cloudCounts = countBy(cloudChildren.map((node) => node.caption));
    const cloudByCaption = new Map(cloudChildren.map((node) => [node.caption, node]));
    for (const task of exportChildren) {
      if (exportCounts.get(task.Caption) === 1 && cloudCounts.get(task.Caption) === 1) {
        pairs.push([task, cloudByCaption.get(task.Caption)!]);
      }
    }
  }
  for (const [task, node] of pairs) {
    identity.byPathId.set(task.id, node.uid);
    identity.confidence.set(task.id, positional ? "positional" : "caption-unique");
    alignSiblings(task.Children, node.children, identity);
  }
}

export function alignExportToSnapshot(
  exportRoots: readonly TaskNode[],
  projection: KnownCloudProjection,
): AlignedIdentity {
  const identity: AlignedIdentity = { byPathId: new Map(), confidence: new Map() };
  alignSiblings(exportRoots, buildCloudTree(projection), identity);
  return identity;
}

/**
 * One resolver for the mutation/read tools: structural alignment first, the
 * binary/XML GUID as a cross-check (a contradiction logs and loses — chain
 * recovery misaligns exactly when the tree drifts), and the conservative
 * caption-path walk only for nodes the alignment could not place.
 */
export function buildUidResolver(
  exportRoots: readonly TaskNode[],
  projection: KnownCloudProjection,
): (task: TaskNode) => string | undefined {
  const identity = alignExportToSnapshot(exportRoots, projection);
  return (task) => {
    const structural = identity.byPathId.get(task.id);
    const binary = task.Guid?.toUpperCase();
    if (structural) {
      if (binary && binary !== structural) {
        log(`GUID cross-check mismatch for [${task.id}] "${task.Caption}": binary ${binary} vs structural ${structural} — using structural`);
      }
      return structural;
    }
    return binary ?? resolveTaskUid(task, projection.rows);
  };
}

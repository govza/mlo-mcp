import type { AlignmentRow } from "../cloud/row-store.js";
import type { TaskNode } from "../types.js";

/**
 * Task identity by STRUCTURAL alignment (spec section 3: "identity aligns the
 * export against the row store").
 *
 * The authoritative tree is built from the captured rows — `UID`/`ParentUID`
 * for shape, numeric `ItemIndex` for sibling order (an ordering key, not an
 * array position). The fresh XML export outline is then aligned against it:
 * when a parent slot has the same number of children on both sides, children
 * pair by position with caption equality as a veto; when the counts differ
 * (drift mid-write), only children whose caption is unique within BOTH sibling
 * lists pair up. Everything else stays unresolved — fail closed rather than
 * guess.
 *
 * Caption-path matching cannot be the identity authority because duplicate
 * sibling captions are legal and real; binary `.ml` GUID recovery is a
 * cross-check only (its chain alignment deliberately skips nodes, and its
 * footer marker is known to misread on some files).
 *
 * Ported from the pre-rearchitecture `cloud/structure-align.ts`, which aligned
 * against the deleted delta-log projection; the row store now serves the same
 * columns.
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

function buildCloudTree(rows: readonly AlignmentRow[]): CloudNode[] {
  const nodes = new Map<string, CloudNode>();
  for (const row of rows) {
    nodes.set(row.uid, { uid: row.uid, caption: row.caption, itemIndex: row.itemIndex, children: [] });
  }
  const roots: CloudNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.uid)!;
    const parentNode = row.parentUid ? nodes.get(row.parentUid) : undefined;
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

export function alignExportToRows(
  exportRoots: readonly TaskNode[],
  rows: readonly AlignmentRow[],
): AlignedIdentity {
  const identity: AlignedIdentity = { byPathId: new Map(), confidence: new Map() };
  alignSiblings(exportRoots, buildCloudTree(rows), identity);
  return identity;
}

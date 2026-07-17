import { XMLParser, XMLBuilder } from "fast-xml-parser";

/**
 * Raw shape of a <TaskNode> element as parsed by fast-xml-parser.
 * All scalar values stay strings (parseTagValue: false) so that an
 * unmodified document round-trips without reformatting values.
 * Delphi booleans are the string "-1".
 */
export interface RawTaskNode {
  "@_Caption": string;
  TaskNode?: RawTaskNode[];
  /** Task GUID; exported by MLO only when another task depends on this one. */
  IDD?: string;
  /** Dependency on other tasks, referencing their IDD GUIDs. */
  Dependency?: { UID?: string[] };
  Note?: string;
  Importance?: string;
  Effort?: string;
  DueDateTime?: string;
  StartDateTime?: string;
  CompletionDateTime?: string;
  IsProject?: string;
  ProjectStatus?: string;
  Starred?: string;
  Flag?: string;
  Places?: { Place?: string[] };
  EstimateMin?: string;
  EstimateMax?: string;
  TheGoal?: string;
  HideInToDo?: string;
  HideInToDoThisTask?: string;
  ScheduleType?: string;
  LeadTime?: string;
  CompleteSubTasksInOrder?: string;
  [key: string]: unknown;
}

export interface MloDocument {
  "MyLifeOrganized-xml": {
    "@_ver": string;
    TaskTree: { TaskNode: RawTaskNode[] };
    /** PConfig, PlacesList, views, columns… — preserved untouched on round-trips */
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const SHARED_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: true,
} as const;

const parser = new XMLParser({
  ...SHARED_OPTIONS,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name: string) => name === "TaskNode" || name === "Place" || name === "TaskPlace" || name === "UID",
});

const builder = new XMLBuilder({
  ...SHARED_OPTIONS,
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true,
  suppressBooleanAttributes: false,
});

/**
 * With trimValues:false the parser records inter-element whitespace as "#text"
 * entries on every container element. Drop the whitespace-only ones (real mixed
 * content, e.g. Flag icon base64, is kept).
 */
function dropWhitespaceText(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) dropWhitespaceText(v);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string" && (obj["#text"] as string).trim() === "") {
      delete obj["#text"];
    }
    for (const v of Object.values(obj)) dropWhitespaceText(v);
  }
}

export function parseMloXml(xml: string): MloDocument {
  const doc = parser.parse(xml) as MloDocument;
  const rootList = doc["MyLifeOrganized-xml"]?.TaskTree?.TaskNode;
  if (!rootList || rootList.length === 0) {
    throw new Error("not a MyLifeOrganized XML export: missing MyLifeOrganized-xml/TaskTree/TaskNode");
  }
  dropWhitespaceText(doc);
  return doc;
}

/** Root TaskNode (Caption="") whose children are the top-level tasks. */
export function rootNode(doc: MloDocument): RawTaskNode {
  return doc["MyLifeOrganized-xml"].TaskTree.TaskNode[0];
}

/** Element order used by MLO's own exports; unknown elements keep their place before children. */
const FIELD_ORDER = [
  "IDD",
  "Note",
  "Dependency",
  "Importance",
  "Effort",
  "CompletionDateTime",
  "DueDateTime",
  "StartDateTime",
  "IsProject",
  "ProjectStatus",
  "Starred",
  "Flag",
  "Places",
  "EstimateMin",
  "EstimateMax",
  "TheGoal",
  "HideInToDo",
  "HideInToDoThisTask",
  "ScheduleType",
  "LeadTime",
  "CompleteSubTasksInOrder",
];

/**
 * Set (value !== undefined) or remove (value === undefined) a scalar field,
 * rebuilding the node's key order so new elements serialize before the nested
 * <TaskNode> children, matching MLO's own layout.
 */
export function setRawField(node: RawTaskNode, key: string, value: unknown): void {
  if (value === undefined) {
    delete node[key];
  } else {
    node[key] = value;
  }
  const children = node.TaskNode;
  delete node.TaskNode;
  const entries = Object.entries(node);
  for (const k of Object.keys(node)) delete node[k];
  const rank = (k: string) => {
    if (k.startsWith("@_")) return -1;
    const i = FIELD_ORDER.indexOf(k);
    return i === -1 ? FIELD_ORDER.length : i;
  };
  entries.sort((a, b) => rank(a[0]) - rank(b[0]));
  for (const [k, v] of entries) node[k] = v;
  if (children) node.TaskNode = children;
}

export function buildMloXml(doc: MloDocument): string {
  // The parsed "?xml" declaration key does not rebuild reliably; emit it ourselves.
  const { "?xml": _decl, ...rest } = doc as Record<string, unknown>;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(rest);
}

import { XMLParser } from "fast-xml-parser";

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

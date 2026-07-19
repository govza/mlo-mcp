/**
 * Human-readable catalog of the tool registry — the same tools an MCP client
 * sees, described from each tool's own zod schemas so this can never drift.
 * Rendering only; the CLI lives in scripts/tools.ts.
 */
import { z } from "zod";
import { allTools } from "../src/tools/registry.js";
import type { MloTool } from "../src/tools/shared.js";

export type ToolKind = "read" | "write" | "destructive";

export interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  /** One level of nesting for object / object[] params (e.g. add_task's `tasks`). */
  fields?: FieldInfo[];
}

export interface ToolInfo {
  name: string;
  title: string;
  kind: ToolKind;
  description: string;
  annotations: MloTool["annotations"];
  input: FieldInfo[];
  output: FieldInfo[];
}

const WIDTH = 96;

function kindOf(tool: MloTool): ToolKind {
  if (tool.annotations.destructiveHint) return "destructive";
  return tool.annotations.readOnlyHint ? "read" : "write";
}

/** Strip optional/nullable/default wrappers down to the schema carrying the type. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const inner = (schema._def as { innerType?: z.ZodTypeAny }).innerType;
  return inner ? unwrap(inner) : schema;
}

/** `.describe()` may sit on any wrapper level, so walk outside-in. */
function descriptionOf(schema: z.ZodTypeAny): string | undefined {
  let current: z.ZodTypeAny | undefined = schema;
  while (current) {
    if (current.description) return current.description;
    current = (current._def as { innerType?: z.ZodTypeAny }).innerType;
  }
  return undefined;
}

function numberType(def: { checks?: Array<{ kind: string; value?: number }> }): string {
  const base = def.checks?.some((c) => c.kind === "int") ? "int" : "number";
  const min = def.checks?.find((c) => c.kind === "min")?.value;
  const max = def.checks?.find((c) => c.kind === "max")?.value;
  if (min !== undefined && max !== undefined) return `${base} ${min}-${max}`;
  if (min !== undefined) return `${base} >=${min}`;
  if (max !== undefined) return `${base} <=${max}`;
  return base;
}

function typeOf(schema: z.ZodTypeAny): string {
  const def = unwrap(schema)._def as {
    typeName?: string;
    checks?: Array<{ kind: string; value?: number }>;
    values?: string[];
    value?: unknown;
    type?: z.ZodTypeAny;
    minLength?: { value: number } | null;
    maxLength?: { value: number } | null;
    options?: z.ZodTypeAny[];
  };
  switch (def.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return numberType(def);
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return (def.values ?? []).join("|");
    case "ZodLiteral":
      return JSON.stringify(def.value);
    case "ZodUnion":
      return (def.options ?? []).map(typeOf).join("|");
    case "ZodObject":
      return "object";
    case "ZodRecord":
      return "record";
    case "ZodArray": {
      const item = def.type ? typeOf(def.type) : "any";
      const min = def.minLength?.value;
      const max = def.maxLength?.value;
      const size = min !== undefined && max !== undefined ? ` (${min}-${max})` : "";
      return `${item}[]${size}`;
    }
    case "ZodAny":
    case "ZodUnknown":
      return "any";
    default:
      return def.typeName?.replace(/^Zod/, "").toLowerCase() ?? "unknown";
  }
}

/** Shape of an object param, or of an array's element — for one level of expansion. */
function nestedShape(schema: z.ZodTypeAny): z.ZodRawShape | undefined {
  const base = unwrap(schema);
  const def = base._def as { typeName?: string; type?: z.ZodTypeAny };
  if (def.typeName === "ZodObject") return (base as z.ZodObject<z.ZodRawShape>).shape;
  if (def.typeName === "ZodArray" && def.type) return nestedShape(def.type);
  return undefined;
}

function fieldsOf(shape: z.ZodRawShape, expand: boolean): FieldInfo[] {
  return Object.entries(shape).map(([name, schema]) => {
    const nested = expand ? nestedShape(schema) : undefined;
    return {
      name,
      type: typeOf(schema),
      required: !schema.isOptional(),
      description: descriptionOf(schema),
      ...(nested ? { fields: fieldsOf(nested, false) } : {}),
    };
  });
}

export function toolInfo(tool: MloTool, expand = false): ToolInfo {
  return {
    name: tool.name,
    title: tool.title,
    kind: kindOf(tool),
    description: tool.description,
    annotations: tool.annotations,
    input: fieldsOf(tool.inputSchema, expand),
    output: fieldsOf(tool.outputSchema, expand),
  };
}

export function catalog(expand = false): ToolInfo[] {
  return allTools.map((tool) => toolInfo(tool, expand));
}

function wrap(text: string, indent: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    // Kept verbatim: some descriptions embed indented outlines as examples,
    // where the leading spaces carry the meaning.
    const lead = /^[ \t]*/.exec(paragraph)![0].replaceAll("\t", "  ");
    const prefix = indent + lead;
    const width = Math.max(20, WIDTH - prefix.length);
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(`${prefix}${line}`);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(`${prefix}${line}`.trimEnd());
  }
  return lines;
}

/** Tool descriptions are prose full of "e.g." — don't end the sentence there. */
const ABBREVIATION = /(?:^|\s|\()(?:e\.g|i\.e|etc|vs|approx|cf|Inc|no)\.$/i;

/** Opening sentence, for the one-line-per-tool overview. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const boundary = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(flat)) !== null) {
    const candidate = flat.slice(0, match.index + 1);
    if (!ABBREVIATION.test(candidate)) return clamp(candidate);
  }
  return clamp(flat);
}

function clamp(text: string): string {
  return text.length > 150 ? `${text.slice(0, 149)}…` : text;
}

function paramSummary(fields: FieldInfo[]): string {
  if (!fields.length) return "(none)";
  const names = fields.map((f) => (f.required ? f.name : `${f.name}?`));
  const shown = names.slice(0, 9).join(", ");
  return names.length > 9 ? `${shown}, … (+${names.length - 9})` : shown;
}

export function renderList(): string {
  const out: string[] = [];
  const tools = catalog();
  out.push(`${tools.length} MLO tools — required params are bare, optional ones end with "?"`, "");
  for (const kind of ["read", "write", "destructive"] as const) {
    const group = tools.filter((t) => t.kind === kind);
    if (!group.length) continue;
    out.push(`${kind.toUpperCase()}`);
    for (const tool of group) {
      out.push(`  ${tool.name}`);
      out.push(...wrap(firstSentence(tool.description), "      "));
      out.push(...wrap(`params  ${paramSummary(tool.input)}`, "      "));
      out.push("");
    }
  }
  out.push(
    "Full schema for one tool   pnpm tools <name>",
    "Call a tool for real       pnpm tool <name> '<json>'",
    "Machine-readable catalog   pnpm tools --json"
  );
  return out.join("\n");
}

function renderFields(fields: FieldInfo[], indent: string): string[] {
  if (!fields.length) return [`${indent}(none)`];
  const label = (f: FieldInfo) => `${f.name}${f.required ? "" : "?"}`;
  const nameWidth = Math.min(20, Math.max(...fields.map((f) => label(f).length)));
  const out: string[] = [];
  for (const field of fields) {
    const typeCell = `${label(field).padEnd(nameWidth)}  ${field.type}`;
    out.push(`${indent}${typeCell}`);
    if (field.description) out.push(...wrap(field.description, `${indent}    `));
    if (field.fields?.length) {
      out.push(`${indent}    fields:`);
      out.push(...renderFields(field.fields, `${indent}      `));
    }
  }
  return out;
}

export function renderDetail(name: string): string | undefined {
  const tool = allTools.find((t) => t.name === name);
  if (!tool) return undefined;
  const info = toolInfo(tool, true);
  const hints = Object.entries(info.annotations)
    .map(([key, value]) => `${key.replace(/Hint$/, "")}=${value}`)
    .join("  ");
  return [
    `${info.name} — ${info.title}  [${info.kind}]`,
    "",
    ...wrap(info.description, ""),
    "",
    "INPUT",
    ...renderFields(info.input, "  "),
    "",
    "OUTPUT (structuredContent)",
    ...renderFields(info.output, "  "),
    "",
    `HINTS  ${hints}`,
    "",
    `RUN    pnpm tool ${info.name} '${JSON.stringify(
      Object.fromEntries(info.input.filter((f) => f.required).map((f) => [f.name, `<${f.type}>`]))
    )}'`,
  ].join("\n");
}

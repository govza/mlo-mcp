import type { MloDocument } from "./xml.js";

/**
 * A context (MLO "Place") as the profile defines it: the open/closed hours that
 * hide its tasks outside the window, and the narrower contexts it includes
 * ([docs/mlo/mlo-task-model.md](../../docs/mlo/mlo-task-model.md) §3,
 * "Contexts are hierarchical"). Domain tier — parsing and clock arithmetic
 * only, no policy: what a closed context *does* to a task is the availability
 * engine's call.
 */
export interface PlaceDefinition {
  Caption: string;
  /** Empty = always open. */
  open: OpenWindow[];
  /** Captions of the contexts this one subsumes ("Home includes Phone"). */
  includes: string[];
}

export interface OpenWindow {
  /** MLO's two-letter codes: MO TU WE TH FR SA SU. */
  days: string[];
  /** "HH:MM:SS" local. */
  start: string;
  end: string;
}

interface RawOpen {
  "@_Days"?: string;
  "@_StartTime"?: string;
  "@_EndTime"?: string;
}

interface RawIncludes {
  "@_Place"?: string;
}

interface RawTaskPlace {
  "@_Caption": string;
  Open?: RawOpen | RawOpen[];
  Includes?: RawIncludes | RawIncludes[];
}

/** fast-xml-parser collapses a single child element to a bare object. */
function many<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** The profile's declared contexts. Tasks may reference contexts absent here. */
export function readPlaces(doc: MloDocument): PlaceDefinition[] {
  const list = doc["MyLifeOrganized-xml"].PlacesList as { TaskPlace?: RawTaskPlace | RawTaskPlace[] } | undefined;
  return many(list?.TaskPlace).map((p) => ({
    Caption: p["@_Caption"],
    open: many(p.Open)
      .filter((o) => o["@_StartTime"] && o["@_EndTime"])
      .map((o) => ({
        days: (o["@_Days"] ?? "").split(/\s+/).filter(Boolean).map((d) => d.toUpperCase()),
        start: o["@_StartTime"] as string,
        end: o["@_EndTime"] as string,
      })),
    includes: many(p.Includes)
      .map((i) => i["@_Place"])
      .filter((c): c is string => Boolean(c)),
  }));
}

/** Contexts compare without their leading @ and without case. */
export function normalizeContext(caption: string): string {
  return caption.replace(/^@/, "").toLowerCase();
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function clockOf(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * Is this context open at `at`? A context with no declared windows is always
 * open, and so is one the profile never declared — MLO only hides a task whose
 * context says when it is reachable.
 */
export function isOpenAt(place: PlaceDefinition | undefined, at: Date): boolean {
  if (!place || place.open.length === 0) return true;
  const day = DAY_CODES[at.getDay()];
  const clock = clockOf(at);
  return place.open.some((w) => w.days.includes(day) && w.start <= clock && clock <= w.end);
}

/**
 * Every context a filter for `caption` reaches, following `Includes` downward:
 * filtering by Home must surface the tasks tagged Phone. Returns normalized
 * captions; cycles terminate.
 */
export function expandContext(places: PlaceDefinition[], caption: string): Set<string> {
  const byCaption = new Map(places.map((p) => [normalizeContext(p.Caption), p]));
  const reached = new Set<string>();
  const queue = [normalizeContext(caption)];
  while (queue.length) {
    const next = queue.shift() as string;
    if (reached.has(next)) continue;
    reached.add(next);
    for (const child of byCaption.get(next)?.includes ?? []) queue.push(normalizeContext(child));
  }
  return reached;
}

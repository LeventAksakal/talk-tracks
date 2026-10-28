// The one adapter between the wire contract (MSF event-timeline records, design §4.2) and the playback
// layer. The contract's types, names and validation live in ../contracts; this file maps a validated
// object to what the playback layer works with, and builds objects for the fakes.

import { agentPath, agentsPrefix, ITEMS_TRACK, OUTLINE_TRACK } from "../contracts/names";
import {
  type CarryRecord,
  type Chapter,
  type Cue,
  type CueRecord,
  type GlossaryTerm,
  isCarryRecord,
  type OutlineRecord,
  type Slide,
  type SlideRecord,
  SLICE_MS,
} from "../contracts/types";
import { type Parsed, parseCueObject, parseOutlineObject, parseSlideObject } from "../contracts/validate";

export { agentPath, agentsPrefix, ITEMS_TRACK, OUTLINE_TRACK };
export type { Parsed };

export type TrackKind = "captions" | "translation" | "slides" | "outline";

/** A track this viewer can opt into: one agent, one track name. */
export interface TrackRef {
  agent: string;
  track: string;
  kind: TrackKind | undefined;
  lang: string | undefined;
  /** Sliced on the room clock (items), or a snapshot track (outline). */
  sliced: boolean;
}

/** Split an announced path under the agents prefix: `<agent>` only. Old `<agent>/<instance>` paths are not ours. */
export function parseAgentPath(rel: string): string | null {
  return /^[a-z0-9][a-z0-9-]*$/i.test(rel) ? rel : null;
}

/** What an agent publishes, from its name (the room catalog adds labels and L, design §5.10). */
export function tracksOf(agent: string): TrackRef[] {
  if (agent === "chapters") return [{ agent, track: OUTLINE_TRACK, kind: "outline", lang: undefined, sliced: false }];
  if (agent === "captions") return [{ agent, track: ITEMS_TRACK, kind: "captions", lang: undefined, sliced: true }];
  const tr = /^translate-([a-z]{2,3}(?:-[a-z0-9]+)?)$/i.exec(agent);
  if (tr?.[1]) return [{ agent, track: ITEMS_TRACK, kind: "translation", lang: tr[1], sliced: true }];
  if (agent === "describe") return [{ agent, track: ITEMS_TRACK, kind: "slides", lang: undefined, sliced: true }];
  return [{ agent, track: ITEMS_TRACK, kind: undefined, lang: undefined, sliced: true }];
}

/** moq-lite priorities, higher first (design §5.11). History always goes last. */
export const PRIORITY: Record<TrackKind | "unknown" | "fetch", number> = {
  captions: 224,
  translation: 208,
  slides: 128,
  outline: 96,
  unknown: 96,
  fetch: 32,
};

// --- what the playback layer works with ----------------------------------------------------------

/** A caption or translated cue. The highest `rev` with the same id replaces it; final beats interim. */
export interface LineItem {
  type: "line";
  /** Stable across revisions; a translated cue keeps its caption's id. */
  id: string;
  /** Room time of the first word. */
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
  rev?: number;
}

export interface SlideItem {
  type: "slide";
  id: number;
  /** Room time when the slide appeared. */
  atMs: number;
  description: string;
}

export type Item = LineItem | SlideItem;

export interface Outline {
  chapters: Chapter[];
  glossary: GlossaryTerm[];
  recap: string;
}

export type WireObject =
  /** Object 0 of a slice: the state at its start (the last cues, or the slide on screen). */
  | { kind: "carry"; capped: boolean; items: Item[] }
  /** Objects 1 and up: new records. */
  | { kind: "items"; items: Item[] }
  | { kind: "snapshot"; outline: Outline };

/** One object of a track, by the track's kind and the object's index in its group. */
export function parseObject(payload: Uint8Array, kind: TrackKind | undefined, index: number): Parsed<WireObject> {
  if (kind === "outline") {
    const parsed = parseOutlineObject(payload);
    return parsed.ok ? { ok: true, value: { kind: "snapshot", outline: outlineOf(parsed.value) } } : parsed;
  }
  const parsed: Parsed<(CarryRecord | CueRecord | SlideRecord)[]> =
    kind === "slides"
      ? parseSlideObject(payload)
      : kind === undefined
        ? orElse(parseCueObject(payload), () => parseSlideObject(payload))
        : parseCueObject(payload);
  if (!parsed.ok) return parsed;
  let capped = false;
  const items: Item[] = [];
  for (const r of parsed.value) {
    if (isCarryRecord(r)) capped ||= r.data.tt.capped === true;
    else items.push("at" in r.data ? slide(r.data) : line(r.data));
  }
  return { ok: true, value: index === 0 ? { kind: "carry", capped, items } : { kind: "items", items } };
}

function orElse<T, U>(a: Parsed<T>, b: () => Parsed<U>): Parsed<T | U> {
  return a.ok ? a : b();
}

function line(c: Cue): LineItem {
  return { type: "line", id: c.id, startMs: c.start, endMs: c.end, text: c.text, final: c.final, rev: c.rev };
}

function slide(s: Slide): SlideItem {
  return { type: "slide", id: s.id, atMs: s.at, description: s.text };
}

function outlineOf(records: OutlineRecord[]): Outline {
  const outline: Outline = { chapters: [], glossary: [], recap: "" };
  for (const { data } of records) {
    if (data.kind === "chapter")
      outline.chapters.push({ id: data.id, start_ms: data.start, title: data.title, summary: data.summary });
    else if (data.kind === "term") outline.glossary.push({ term: data.term, definition: data.definition });
    else outline.recap = data.text;
  }
  outline.chapters.sort((a, b) => a.start_ms - b.start_ms);
  return outline;
}

// --- the other direction, for fakes and fixtures ---------------------------------------------------

const encoder = new TextEncoder();
const json = (records: unknown[]) => encoder.encode(JSON.stringify(records));

/** Encode a carry-in, as an agent publishes object 0 of slice `slice`. */
export function encodeCarry(slice: number, items: Item[], capped = false): Uint8Array {
  const note: CarryRecord[] = capped ? [{ m: slice * SLICE_MS, data: { tt: { capped: true } } }] : [];
  return json([...note, ...items.map(record)]);
}

/** Encode one new record, as an agent publishes objects 1 and up of a slice. */
export function encodeItem(item: Item): Uint8Array {
  return json([record(item)]);
}

/** Encode an outline revision, its terms and recap at `watermarkMs`. */
export function encodeOutline(outline: Outline, watermarkMs: number): Uint8Array {
  const records: OutlineRecord[] = [
    ...outline.chapters.map((c) => ({
      m: c.start_ms,
      data: { kind: "chapter" as const, id: c.id, start: c.start_ms, title: c.title, summary: c.summary },
    })),
    ...outline.glossary.map((g) => ({ m: watermarkMs, data: { kind: "term" as const, ...g } })),
    ...(outline.recap ? [{ m: watermarkMs, data: { kind: "recap" as const, text: outline.recap } }] : []),
  ];
  return json(records);
}

function record(item: Item): CueRecord | SlideRecord {
  if (item.type === "slide") return { m: item.atMs, data: { id: item.id, at: item.atMs, text: item.description } };
  const cue: Cue = { start: item.startMs, end: item.endMs, id: item.id, text: item.text, final: item.final };
  if (item.rev !== undefined) cue.rev = item.rev;
  return { m: item.startMs, data: cue };
}

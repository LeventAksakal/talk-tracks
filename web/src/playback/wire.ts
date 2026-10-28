// The one adapter between the sliced wire contract (decision 0012, design §4.4) and the playback layer.
// Everything that knows the envelope's shape, the broadcast paths and the track names is here, so a
// contract change touches this file only.
//
// Built against the draft envelope v2 on the Lazy agents lane (contracts/envelope.schema.json there):
// `slice`, `kind: carry | item | snapshot`, `capped` on a carry-in, and a `body` discriminated by `type`.
// The checks below are structural; once the v2 schema is merged into contracts/, validate it with Ajv
// as contracts/validate.ts does for v1.

import { ROOT } from "../contracts/names";
import type { Chapter, GlossaryTerm } from "../contracts/types";

/** Every agent publishes under a stable name, without an instance segment. */
export const agentsPrefix = (room: string) => `${ROOT}/${room}/agents`;
export const agentPath = (room: string, agent: string) => `${agentsPrefix(room)}/${agent}`;
/** Every sliced agent track. */
export const ITEMS_TRACK = "items";
/** The chapters agent's snapshot track. */
export const OUTLINE_TRACK = "outline";

export type TrackKind = "captions" | "translation" | "slides" | "outline";

/** A track this viewer can opt into: one agent, one track name. */
export interface TrackRef {
  agent: string;
  track: string;
  kind: TrackKind | undefined;
  lang: string | undefined;
  /** Sliced on the media clock (items), or a snapshot track (outline). */
  sliced: boolean;
}

/** Split an announced path under the agents prefix: `<agent>` only. Old `<agent>/<instance>` paths are not ours. */
export function parseAgentPath(rel: string): string | null {
  return /^[a-z0-9][a-z0-9-]*$/i.test(rel) ? rel : null;
}

/** What an agent publishes, from its name (until the room catalog lists tracks, design §5.10). */
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

/** A caption or translated line. A later version with the same id replaces it; final beats interim. */
export interface LineItem {
  type: "line";
  id: number;
  /** Media time of the first word. 0 when the source line's time is unknown (older translations). */
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}

export interface SlideItem {
  type: "slide";
  id: number;
  /** Media time when the slide appeared. */
  atMs: number;
  description: string;
}

export type Item = LineItem | SlideItem;

export interface Outline {
  lang: string;
  chapters: Chapter[];
  glossary: GlossaryTerm[];
  recap: string;
}

export interface AgentMeta {
  name: string;
  label: string;
  model: string;
  costUsd: number;
  requests: number;
}

export type WireObject =
  | {
      kind: "carry";
      slice: number;
      capped: boolean;
      lang: string;
      /** The state at the slice start: the last lines, or the slide on screen. */
      items: Item[];
      agent: AgentMeta;
    }
  | { kind: "item"; slice: number; lang: string; item: Item; agent: AgentMeta }
  | { kind: "snapshot"; slice: number; outline: Outline; agent: AgentMeta };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const decoder = new TextDecoder();

export function parseObject(payload: Uint8Array): Parsed<WireObject> {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(payload));
  } catch (e) {
    return { ok: false, error: `not JSON: ${String(e)}` };
  }
  try {
    return { ok: true, value: fromEnvelope(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function fromEnvelope(raw: unknown): WireObject {
  const env = obj(raw, "envelope");
  const slice = int(env.slice, "slice");
  const kind = env.kind;
  const body = obj(env.body, "body");
  const type = str(body.type, "body.type");
  const lang = typeof body.lang === "string" ? body.lang : "";
  const agentRaw = obj(env.agent, "agent");
  const usage = env.usage && typeof env.usage === "object" ? (env.usage as Record<string, unknown>) : {};
  const agent: AgentMeta = {
    name: str(agentRaw.name, "agent.name"),
    label: str(agentRaw.label, "agent.label"),
    model: str(agentRaw.model, "agent.model"),
    costUsd: typeof usage.cost_usd === "number" ? usage.cost_usd : 0,
    requests: typeof usage.requests === "number" ? usage.requests : 0,
  };

  if (kind === "snapshot") {
    if (type !== "outline") throw new Error(`a snapshot holds an outline, not ${type}`);
    const outline: Outline = {
      lang,
      chapters: arr(body.chapters, "chapters").map(chapter),
      glossary: arr(body.glossary, "glossary").map(term),
      recap: typeof body.recap === "string" ? body.recap : "",
    };
    return { kind, slice, outline, agent };
  }
  if (kind === "carry") {
    const capped = env.capped === true;
    let items: Item[];
    if (type === "captions-carry" || type === "translation-carry") items = arr(body.lines, "lines").map(finalLine);
    else if (type === "slides-carry") items = body.slide == null ? [] : [slide(body.slide)];
    else throw new Error(`unknown carry-in type ${type}`);
    return { kind, slice, capped, lang, items, agent };
  }
  if (kind === "item") {
    let item: Item;
    if (type === "caption") item = { ...line(body.line), final: body.final === true };
    else if (type === "translation") item = finalLine(body.line);
    else if (type === "slide") item = slide(body.slide);
    else throw new Error(`unknown item type ${type}`);
    return { kind, slice, lang, item, agent };
  }
  throw new Error(`unknown kind ${String(kind)}`);
}

function line(raw: unknown): LineItem {
  const l = obj(raw, "line");
  return {
    type: "line",
    id: int(l.id, "line.id"),
    startMs: typeof l.start_ms === "number" ? l.start_ms : 0,
    endMs: typeof l.end_ms === "number" ? l.end_ms : 0,
    text: str(l.text, "line.text"),
    final: true,
  };
}

const finalLine = (raw: unknown): LineItem => line(raw);

function slide(raw: unknown): SlideItem {
  const s = obj(raw, "slide");
  return {
    type: "slide",
    id: int(s.id, "slide.id"),
    atMs: int(s.at_ms, "slide.at_ms"),
    description: str(s.description, "slide.description"),
  };
}

function chapter(raw: unknown): Chapter {
  const c = obj(raw, "chapter");
  return {
    id: int(c.id, "chapter.id"),
    start_ms: int(c.start_ms, "chapter.start_ms"),
    title: str(c.title, "chapter.title"),
    summary: str(c.summary, "chapter.summary"),
  };
}

function term(raw: unknown): GlossaryTerm {
  const t = obj(raw, "term");
  return { term: str(t.term, "term.term"), definition: str(t.definition, "term.definition") };
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is not an object`);
  return v as Record<string, unknown>;
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} is not a list`);
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} is not a string`);
  return v;
}

function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${what} is not a whole number >= 0`);
  return v;
}

// --- the other direction, for fakes and fixtures ---------------------------------------------------

const encoder = new TextEncoder();

export interface EncodeOptions {
  agent: { name: string; label: string; model: string };
  lang: string;
  kind: TrackKind;
  costUsd?: number;
}

/** Encode a carry-in, as an agent publishes object 0 of a slice. */
export function encodeCarry(o: EncodeOptions, slice: number, items: Item[], capped = false): Uint8Array {
  const body =
    o.kind === "slides"
      ? {
          type: "slides-carry",
          lang: o.lang,
          slide: items[0] && items[0].type === "slide" ? slideJson(items[0]) : null,
        }
      : { type: `${o.kind}-carry`, lang: o.lang, lines: items.filter(isLine).map(lineJson) };
  return envelopeJson(o, slice, "carry", body, capped);
}

/** Encode one item, as an agent publishes objects 1 and up of a slice. */
export function encodeItem(o: EncodeOptions, slice: number, item: Item): Uint8Array {
  const body =
    item.type === "slide"
      ? { type: "slide", lang: o.lang, slide: slideJson(item) }
      : o.kind === "translation"
        ? { type: "translation", lang: o.lang, line: lineJson(item) }
        : { type: "caption", lang: o.lang, line: lineJson(item), final: item.final };
  return envelopeJson(o, slice, "item", body);
}

export function encodeOutline(o: EncodeOptions, slice: number, outline: Outline): Uint8Array {
  const body = {
    type: "outline",
    lang: o.lang,
    chapters: outline.chapters,
    glossary: outline.glossary,
    recap: outline.recap,
  };
  return envelopeJson(o, slice, "snapshot", body);
}

function envelopeJson(o: EncodeOptions, slice: number, kind: string, body: unknown, capped = false): Uint8Array {
  const usage = { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: o.costUsd ?? 0 };
  const env = { v: 2, agent: o.agent, slice, kind, ...(capped ? { capped } : {}), at_ms: 0, usage, body };
  return encoder.encode(JSON.stringify(env));
}

const isLine = (i: Item): i is LineItem => i.type === "line";
const lineJson = (l: LineItem) => ({ id: l.id, start_ms: l.startMs, end_ms: l.endMs, text: l.text });
const slideJson = (s: SlideItem) => ({ id: s.id, at_ms: s.atMs, description: s.description });

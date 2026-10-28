// The one adapter between the sliced wire contract (envelope v2, decision 0012) and the playback layer.
// The contract's types, names and validation live in ../contracts; this file maps a validated envelope
// to what the playback layer works with, and builds envelopes for the fakes.

import { agentPath, agentsPrefix, ITEMS_TRACK, OUTLINE_TRACK } from "../contracts/names";
import type { Carry, Chapter, Envelope, GlossaryTerm, Usage } from "../contracts/types";
import { parseEnvelope } from "../contracts/validate";

export { agentPath, agentsPrefix, ITEMS_TRACK, OUTLINE_TRACK };

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

/** A caption or translated line. The highest `rev` with the same id replaces it; final beats interim. */
export interface LineItem {
  type: "line";
  id: number;
  /** Room time of the first word. 0 when the source line's time is unknown (older translations). */
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
  /** Revision (WebVTT-MSF cue extension, design §4.2); absent on the v2 envelope. */
  rev?: number;
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

export function parseObject(payload: Uint8Array): Parsed<WireObject> {
  const parsed = parseEnvelope(payload);
  return parsed.ok ? { ok: true, value: fromEnvelope(parsed.value) } : parsed;
}

function fromEnvelope(env: Envelope): WireObject {
  const { slice } = env;
  const agent: AgentMeta = {
    ...env.agent,
    costUsd: env.usage.cost_usd ?? 0,
    requests: env.usage.requests ?? 0,
  };
  const body = env.body;
  switch (body.type) {
    case "outline":
      return {
        kind: "snapshot",
        slice,
        agent,
        outline: { lang: body.lang, chapters: body.chapters, glossary: body.glossary, recap: body.recap ?? "" },
      };
    case "captions-carry":
    case "translation-carry":
      return { kind: "carry", slice, capped: env.capped === true, lang: body.lang, items: body.lines.map(line), agent };
    case "slides-carry":
      return {
        kind: "carry",
        slice,
        capped: env.capped === true,
        lang: body.lang,
        items: body.slide ? [slide(body.slide)] : [],
        agent,
      };
    case "caption":
      return { kind: "item", slice, lang: body.lang, item: { ...line(body.line), final: body.final }, agent };
    case "translation":
      return { kind: "item", slice, lang: body.lang, item: line(body.line), agent };
    case "slide":
      return { kind: "item", slice, lang: body.lang, item: slide(body.slide), agent };
  }
}

function line(l: { id: number; start_ms?: number; end_ms?: number; text: string }): LineItem {
  return { type: "line", id: l.id, startMs: l.start_ms ?? 0, endMs: l.end_ms ?? 0, text: l.text, final: true };
}

function slide(s: { id: number; at_ms: number; description: string }): SlideItem {
  return { type: "slide", id: s.id, atMs: s.at_ms, description: s.description };
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
  const first = items[0];
  const lines = items.filter(isLine).map(lineJson);
  const body: Carry =
    o.kind === "slides"
      ? { type: "slides-carry", lang: o.lang, slide: first?.type === "slide" ? slideJson(first) : null }
      : o.kind === "translation"
        ? { type: "translation-carry", lang: o.lang, lines }
        : { type: "captions-carry", lang: o.lang, lines };
  return envelopeJson(o, slice, "carry", body, capped);
}

/** Encode one item, as an agent publishes objects 1 and up of a slice. */
export function encodeItem(o: EncodeOptions, slice: number, item: Item): Uint8Array {
  const body: Envelope["body"] =
    item.type === "slide"
      ? { type: "slide", lang: o.lang, slide: slideJson(item) }
      : o.kind === "translation"
        ? { type: "translation", lang: o.lang, line: lineJson(item) }
        : { type: "caption", lang: o.lang, line: lineJson(item), final: item.final };
  return envelopeJson(o, slice, "item", body);
}

export function encodeOutline(o: EncodeOptions, slice: number, outline: Outline): Uint8Array {
  const { chapters, glossary, recap } = outline;
  return envelopeJson(o, slice, "snapshot", { type: "outline", lang: o.lang, chapters, glossary, recap });
}

function envelopeJson(
  o: EncodeOptions,
  slice: number,
  kind: Envelope["kind"],
  body: Envelope["body"],
  capped = false,
): Uint8Array {
  const usage: Usage = { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: o.costUsd ?? 0 };
  const env = { v: 2, agent: o.agent, slice, kind, ...(capped ? { capped } : {}), at_ms: 0, usage, body };
  return encoder.encode(JSON.stringify(env));
}

const isLine = (i: Item): i is LineItem => i.type === "line";
const lineJson = (l: LineItem) => ({ id: l.id, start_ms: l.startMs, end_ms: l.endMs, text: l.text });
const slideJson = (s: SlideItem) => ({ id: s.id, at_ms: s.atMs, description: s.description });

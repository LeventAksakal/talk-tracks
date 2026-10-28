// TypeScript view of the wire contracts. The JSON Schemas in /contracts (generated from
// agents/src/talk_tracks/contracts.py) are the source of truth: every received object is validated
// against them (see validate.ts) before it is treated as one of these types.
//
// Envelope v2 (decision 0012): an agent publishes talk/<room>/agents/<agent> under a stable name. Its
// `items` track is cut into slices on the room clock: group k covers room time [k·4 s, (k+1)·4 s).
// Object 0 of a group is the carry-in (a small state that makes the group useful on its own), objects
// 1 and up are items, one per object; End of Group closes the slice and End of Track ends the talk.
// The chapters agent's `outline` track is a snapshot track: one group of one object per revision.
// The Location (group, object) is the sequence: there is no seq and no instance.

/** Group k of a sliced track covers room time [k * SLICE_MS, (k + 1) * SLICE_MS). */
export const SLICE_MS = 4000;
/** Caption or translated lines a carry-in repeats from before its slice. */
export const CARRY_LINES = 2;

export const sliceOf = (roomMs: number) => Math.floor(Math.max(0, roomMs) / SLICE_MS);

export interface CaptionLine {
  /** Rises with time: the start time in ms (or one more than the previous id); stable across restarts and back-fill. */
  id: number;
  /** Room time of the first word. */
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface TranslatedLine {
  /** The source caption line's id. */
  id: number;
  /** The source line's times. */
  start_ms?: number;
  end_ms?: number;
  text: string;
}

export interface SlideNote {
  id: number;
  /** Room time when the slide appeared. */
  at_ms: number;
  description: string;
}

export interface Chapter {
  id: number;
  start_ms: number;
  title: string;
  summary: string;
}

export interface GlossaryTerm {
  term: string;
  definition: string;
}

// --- on the wire: carry-ins, items and the outline snapshot -------------------------------------

export interface CaptionsCarry {
  type: "captions-carry";
  lang: string;
  /** The last final lines before the slice (at most CARRY_LINES). */
  lines: CaptionLine[];
}

export interface CaptionItem {
  type: "caption";
  lang: string;
  line: CaptionLine;
  /** False for an interim version of the line being spoken: any later item replaces it. */
  final: boolean;
}

export interface TranslationCarry {
  type: "translation-carry";
  lang: string;
  lines: TranslatedLine[];
}

export interface TranslationItem {
  type: "translation";
  lang: string;
  line: TranslatedLine;
}

export interface SlidesCarry {
  type: "slides-carry";
  lang: string;
  /** The slide on screen when the slice starts, if any. */
  slide: SlideNote | null;
}

export interface SlideItem {
  type: "slide";
  lang: string;
  slide: SlideNote;
}

export interface OutlineSnapshot {
  type: "outline";
  lang: string;
  chapters: Chapter[];
  glossary: GlossaryTerm[];
  recap?: string;
}

export type Carry = CaptionsCarry | TranslationCarry | SlidesCarry;
export type Item = CaptionItem | TranslationItem | SlideItem;
export type Body = Carry | Item | OutlineSnapshot;
export type BodyType = Body["type"];

export interface Usage {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}

export interface AgentInfo {
  /** Stable agent name, for example captions or translate-tr. */
  name: string;
  /** What a viewer sees in the track list. */
  label: string;
  /** Which model does the work, or 'none'. */
  model: string;
}

interface EnvelopeBase {
  v?: 2;
  agent: AgentInfo;
  /** The group: room time [slice * 4 s, (slice + 1) * 4 s); for the outline, that of the revision. */
  slice: number;
  /** Wall-clock time of publication. */
  at_ms: number;
  /** Cumulative model usage of the agent process. */
  usage: Usage;
}

/** One object of an agent track. `kind` says where it sits in its group. */
export type Envelope =
  | (EnvelopeBase & {
      kind: "carry";
      /** The room reached its spend cap: no items follow in this slice. */
      capped?: boolean;
      body: Carry;
    })
  | (EnvelopeBase & { kind: "item"; capped?: false; body: Item })
  | (EnvelopeBase & { kind: "snapshot"; capped?: false; body: OutlineSnapshot });

export type EnvelopeKind = Envelope["kind"];

export interface SlideFrame {
  id: number;
  /** Room time when the slide appeared. */
  at_ms: number;
  mime: "image/jpeg" | "image/png";
  data_b64: string;
}

/**
 * The room clock (design §4.5): the speaker console publishes it on track `clock` in `talk/<room>/slides`, before
 * its audio, a group on change and every 4 s. Room time = the speaker's media timestamp + `offset_ms`; every `*_ms`
 * media time and every slice number in the contracts is room time.
 */
export interface RoomClock {
  /** Wall time of the room's first broadcast. */
  epoch_ms: number;
  /** Added to this broadcast's media timestamps to give room time. */
  offset_ms: number;
  /** This broadcast: its start, wall ms. */
  session: string;
}

// --- full states: what the agents' cores keep and recordings store (not on the wire) ------------

export interface CaptionsState {
  kind: "captions";
  lang: string;
  lines: CaptionLine[];
  interim?: string;
}

export interface TranslationState {
  kind: "translation";
  lang: string;
  lines: TranslatedLine[];
}

export interface SlidesState {
  kind: "slides";
  lang: string;
  slides: SlideNote[];
}

export interface OutlineState {
  kind: "outline";
  lang: string;
  chapters: Chapter[];
  glossary: GlossaryTerm[];
  recap?: string;
}

export type State = CaptionsState | TranslationState | SlidesState | OutlineState;
export type StateKind = State["kind"];

/**
 * Envelope v1 (one full-state snapshot per group, under talk/<room>/agents/<agent>/<instance>, track
 * `state`). Agents no longer publish it; it stays only for the room store and the demo script until the
 * Rewind lane moves them to v2. Validated against legacy-envelope.schema.json.
 * @deprecated use Envelope
 */
export interface LegacyEnvelope {
  v?: 1;
  agent: AgentInfo;
  instance: string;
  seq: number;
  at_ms: number;
  usage: Usage;
  state: State;
}

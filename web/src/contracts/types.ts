// TypeScript view of the wire contracts. The JSON Schemas in /contracts (generated from
// agents/src/talk_tracks/contracts.py) are the source of truth: every received object is validated
// against them (see validate.ts) before it is treated as one of these types.
//
// Design §4 (decision 0012): an agent publishes talk/<room>/agents/<agent> under a stable name. Its
// `items` track is an MSF event timeline cut into slices on the room clock: group k holds the records
// whose room time is in [k·4 s, (k+1)·4 s). Each object is a JSON array of records {m, data} (MSF §8.1).
// Object 0 is the carry-in (the last cues, or the slide on screen), objects 1 and up the slice's new
// records; End of Group closes the slice, End of Track comes only when the room is closed. The chapters
// agent's `outline` track has one group per revision, holding the whole outline as one object.
// Every time is room time in ms: wall time of the speaker's media − E (+ the broadcast's tt.shift).

/** Group k of a sliced track covers room time [k * SLICE_MS, (k + 1) * SLICE_MS). */
export const SLICE_MS = 4000;
/** Cues a carry-in repeats from before its slice. */
export const CARRY_CUES = 2;
/** @deprecated legacy name of CARRY_CUES */
export const CARRY_LINES = CARRY_CUES;
/** hang's clock.wall counts from 2020-01-01T00:00:00Z. */
export const MOQ_EPOCH_UNIX_MS = 1_577_836_800_000;

export const sliceOf = (roomMs: number) => Math.floor(Math.max(0, roomMs) / SLICE_MS);

/** Wall time of a media timestamp from the teacher hang catalog's root clock (as @moq/hang wallClockTime). */
export const wallUnixMs = (wall: number, timescale: number, ptsMs: number) =>
  MOQ_EPOCH_UNIX_MS + (1000 * wall) / timescale + ptsMs;

/** Room time of a wall time: minus the room epoch E, plus the broadcast's tt.shift. */
export const roomMs = (wallMs: number, epoch: number, shift: number) => Math.trunc(wallMs - epoch + shift);

// --- on the wire: MSF event-timeline records -----------------------------------------------------

/** A WebVTT-MSF cue (WebVTT-MSF §3) plus rev and final. Merge by id, keep the highest rev. */
export interface Cue {
  /** Room ms of the first word; the record's m. */
  start: number;
  end: number;
  /** Stable across revisions, restarts and back-fill; a translated cue keeps its caption's id. */
  id: string;
  text: string;
  rev?: number;
  /** False while the speaker is still saying it. */
  final: boolean;
}

export interface CueRecord {
  m: number;
  data: Cue;
}

export interface Slide {
  id: number;
  /** Room ms when the slide appeared; the record's m. */
  at: number;
  /** What the slide shows, described for a viewer who cannot see it. */
  text: string;
}

export interface SlideRecord {
  m: number;
  data: Slide;
}

/** Talk Tracks' note on a carry-in: its first record, only when there is something to say. */
export interface CarryRecord {
  /** The slice start, k * 4000. */
  m: number;
  data: {
    tt: {
      /** The room reached its spend cap: no new records follow in this slice. */
      capped?: boolean;
      /** Room ms where the agent started inside the slice: nothing before it (captions). */
      from?: number | null;
    };
  };
}

/** One object of a captions or translation items track (eventType urn:msf:captions:webvtt). */
export type CueObject = (CarryRecord | CueRecord)[];
/** One object of the slide descriptions' items track (eventType com.talktracks.slides). */
export type SlideObject = (CarryRecord | SlideRecord)[];

export interface ChapterData {
  kind: "chapter";
  id: number;
  start: number;
  title: string;
  summary: string;
}

export interface TermData {
  kind: "term";
  term: string;
  definition: string;
}

export interface RecapData {
  kind: "recap";
  text: string;
}

/** m: a chapter's start; for a term or the recap, the revision's watermark. */
export interface OutlineRecord {
  m: number;
  data: ChapterData | TermData | RecapData;
}

/** The only object of an outline revision (eventType com.talktracks.outline). */
export type OutlineObject = OutlineRecord[];

export const CUE_EVENT = "urn:msf:captions:webvtt";
export const SLIDES_EVENT = "com.talktracks.slides";
export const OUTLINE_EVENT = "com.talktracks.outline";

export const isCarryRecord = (r: { data: object }): r is CarryRecord => "tt" in r.data;

// --- the speaker's and the room's event tracks (ui-design §3.4, decisions 0017 and 0018) ---------
//
// Same model: each object is a JSON array of records {m, data}, and every data names its `kind`. The
// sliced tracks (slide, ink, pointer, comments, room) cut group k at room time [k·4 s, (k+1)·4 s);
// object 0 is the carry-in (tracks.ts builds and reads it), objects 1 and up the slice's new records.
// A carry-in record keeps the m of when it took effect, so its m may precede the slice. The deck track
// is not sliced: one group per deck. Positions and sizes are fractions of the slide (x from the left,
// y from the top), never pixels.

/** [x, y], each a fraction of the slide in [0, 1]. */
export type Point = [x: number, y: number];

/** Object 0 of a deck group. The group number is the deck id that slide, ink and comment records name. */
export interface DeckInfo {
  kind: "deck";
  count: number;
  /** Slide width / height, for layout before the images arrive. */
  aspect: number;
  title?: string | null;
}

export interface DeckImage {
  kind: "image";
  /** 0-based slide position in the deck. */
  index: number;
  mime: "image/webp" | "image/jpeg" | "image/png";
  width: number;
  height: number;
  data_b64: string;
  /** The slide's text layer, which comment text spans index into. */
  text?: string | null;
}

export interface DeckRecord {
  m: number;
  data: DeckInfo | DeckImage;
}
/** One object of the `deck` track (eventType com.talktracks.deck). */
export type DeckObject = DeckRecord[];

export interface ShowSlide {
  kind: "show";
  /** The deck track's group holding the deck. */
  deck: number;
  index: number;
}
/** The speaker stopped showing slides. */
export interface HideSlide {
  kind: "hide";
}
export interface CurrentSlideRecord {
  m: number;
  data: ShowSlide | HideSlide;
}
/** One object of the `slide` track (eventType com.talktracks.current-slide). Carry-in: the last record. */
export type CurrentSlideObject = CurrentSlideRecord[];

export type InkTool = "pen" | "highlighter";

interface InkStyle {
  /** Unique in the room, stable across re-sends. */
  stroke: string;
  deck: number;
  index: number;
  tool: InkTool;
  /** #rrggbb */
  color: string;
  /** Line width as a fraction of the slide's width. */
  width: number;
  /** At least one point, in drawing order. */
  points: Point[];
}
export interface InkBegin extends InkStyle {
  kind: "begin";
}
export interface InkPoints {
  kind: "points";
  stroke: string;
  points: Point[];
}
export interface InkEnd {
  kind: "end";
  stroke: string;
}
/** A whole stroke: in a carry-in, or re-sent when a slide that kept its ink is shown again. */
export interface InkStroke extends InkStyle {
  kind: "stroke";
  /** False while still being drawn: points and end follow. */
  done: boolean;
}
export interface InkErase {
  kind: "erase";
  strokes: string[];
}
/** Removes every stroke of one slide. */
export interface InkClear {
  kind: "clear";
  deck: number;
  index: number;
}
export type InkData = InkBegin | InkPoints | InkEnd | InkStroke | InkErase | InkClear;
/** m: when it took effect on screen (a re-sent stroke: when its slide was shown). */
export interface InkRecord {
  m: number;
  data: InkData;
}
/** One object of the `ink` track (eventType com.talktracks.ink). Carry-in: strokes visible on the slide on screen. */
export type InkObject = InkRecord[];

export interface PointerAt {
  kind: "at";
  x: number;
  y: number;
}
export interface PointerOff {
  kind: "off";
}
export interface PointerRecord {
  m: number;
  data: PointerAt | PointerOff;
}
/** One object of the `pointer` track (eventType com.talktracks.pointer), ~20 samples/s while held. Carry-in: the last record. */
export type PointerObject = PointerRecord[];

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Character offsets into the deck image's `text`; end is one past the last. */
export interface TextSpan {
  start: number;
  end: number;
}
/** Where on a slide: a region, a text span, both, or neither (the whole slide). */
export interface Anchor {
  deck: number;
  index: number;
  region?: Region | null;
  span?: TextSpan | null;
}
export interface Comment {
  kind: "comment";
  id: string;
  /** Room ms it was posted at; the record's m is when it appeared (posted, or its slide shown again). */
  at: number;
  /** Display name, 1–60 characters. */
  author: string;
  /** 1–2000 characters. */
  text: string;
  anchor: Anchor;
  question?: boolean;
  speaker?: boolean;
}
export interface Reply {
  kind: "reply";
  id: string;
  at: number;
  /** The thread's comment. */
  to: string;
  author: string;
  text: string;
  /** Written by the speaker: shown first. */
  speaker?: boolean;
}
export interface CommentEdit {
  kind: "edit";
  id: string;
  text: string;
}
export interface CommentHide {
  kind: "hide";
  id: string;
}
export type CommentData = Comment | Reply | CommentEdit | CommentHide;
export interface CommentRecord {
  m: number;
  data: CommentData;
}
/** One object of the `comments` track (eventType com.talktracks.comments). Carry-in: threads on the slide on screen. */
export type CommentsObject = CommentRecord[];

export interface RoomState {
  kind: "state";
  state: "waiting" | "on_air" | "paused" | "ended";
  title?: string | null;
  speaker?: string | null;
}
export interface RoomStateRecord {
  m: number;
  data: RoomState;
}
/** One object of the `room` track (eventType com.talktracks.room). Carry-in: the last record. */
export type RoomStateObject = RoomStateRecord[];

export const DECK_EVENT = "com.talktracks.deck";
export const CURRENT_SLIDE_EVENT = "com.talktracks.current-slide";
export const INK_EVENT = "com.talktracks.ink";
export const POINTER_EVENT = "com.talktracks.pointer";
export const COMMENTS_EVENT = "com.talktracks.comments";
export const ROOM_EVENT = "com.talktracks.room";

// --- the room catalog (design §5.10), track `catalog` in talk/<room>/catalog ----------------------

/** One agent's state; older than 15 s (updated_ms) means stale. */
export interface TrackStatus {
  status: "idle" | "live" | "capped";
  producing: boolean;
  /** FETCHes this agent answered as the origin (relay cache misses). */
  fetches_served: number;
  /** Slices produced for a FETCH. */
  backfills: number;
  spend_usd: number;
  updated_ms: number;
}

/** A picture or sound the speaker is sending now, which the player can lay out (ui-design §3.2). */
export interface Source {
  kind: "audio" | "camera" | "screen" | "slides";
  /** talk/<room>/teacher for audio and camera, talk/<room>/slides for slides. */
  namespace: string;
  /** catalog.json for audio and camera (the hang catalog names the media tracks); deck, slide, ink, pointer for slides. */
  tracks: string[];
  label?: string | null;
}

export interface RoomTt {
  /** The room epoch, Unix ms, a multiple of 4000. */
  E: number;
  /** Per teacher broadcast (its clock.wall as a decimal string): ms added to its room times, 0 normally. */
  shift: Record<string, number>;
  /** Per agent name. */
  status?: Record<string, TrackStatus>;
  /** The speaker's sources, in the speaker's order. */
  sources?: Source[];
}

/** An MSF catalog track (MSF §5.2); other MSF fields pass through. */
export interface CatalogTrack {
  name: string;
  namespace: string;
  packaging: string;
  mimeType?: string | null;
  eventType?: string | null;
  role?: string | null;
  lang?: string | null;
  label?: string | null;
  isLive?: boolean | null;
  template?: unknown[] | null;
  tt?: { dependsOn?: string[]; latenessMs?: number; cost: "paid" | "free" } | null;
  [extra: string]: unknown;
}

export interface RoomCatalog {
  version?: "draft-01";
  tracks: CatalogTrack[];
  tt: RoomTt;
  [extra: string]: unknown;
}

export interface SlideFrame {
  id: number;
  /** Unix wall ms when the slide appeared (performance.timeOrigin + performance.now()). */
  at_ms: number;
  mime: "image/jpeg" | "image/png";
  data_b64: string;
}

// --- full states: what the agents' cores keep and recordings store (not on the wire) ------------

export interface CaptionLine {
  id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface TranslatedLine {
  id: number;
  start_ms?: number;
  end_ms?: number;
  text: string;
}

export interface SlideNote {
  id: number;
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
 * Rewind lane moves them to the event-timeline records. Validated against legacy-envelope.schema.json.
 * @deprecated use the event-timeline records (CueObject and the rest)
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

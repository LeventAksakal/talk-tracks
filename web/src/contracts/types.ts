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

export interface RoomTt {
  /** The room epoch, Unix ms, a multiple of 4000. */
  E: number;
  /** Per teacher broadcast (its clock.wall as a decimal string): ms added to its room times, 0 normally. */
  shift: Record<string, number>;
  /** Per agent name. */
  status?: Record<string, TrackStatus>;
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

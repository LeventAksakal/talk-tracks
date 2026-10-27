// TypeScript view of the wire contracts. The JSON Schemas in /contracts (generated from
// agents/src/talk_tracks/contracts.py) are the source of truth: every received object is validated
// against them (see validate.ts) before it is treated as one of these types.

export interface CaptionLine {
  id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface CaptionsState {
  kind: "captions";
  lang: string;
  lines: CaptionLine[];
  interim?: string;
}

export interface TranslatedLine {
  /** The source caption line's id. */
  id: number;
  text: string;
}

export interface TranslationState {
  kind: "translation";
  lang: string;
  lines: TranslatedLine[];
}

export interface SlideNote {
  id: number;
  at_ms: number;
  description: string;
}

export interface SlidesState {
  kind: "slides";
  lang: string;
  slides: SlideNote[];
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

export interface OutlineState {
  kind: "outline";
  lang: string;
  chapters: Chapter[];
  glossary: GlossaryTerm[];
  recap?: string;
}

export type State = CaptionsState | TranslationState | SlidesState | OutlineState;
export type StateKind = State["kind"];

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

export interface Envelope {
  v?: 1;
  agent: AgentInfo;
  /** Start time of this agent process in ms; a replacement gets a new one. */
  instance: string;
  /** Increases by one per state change; a heartbeat repeats the same seq. */
  seq: number;
  /** Wall-clock time of publication. */
  at_ms: number;
  usage: Usage;
  state: State;
}

export interface SlideFrame {
  id: number;
  /** Media time when the slide appeared. */
  at_ms: number;
  mime: "image/jpeg" | "image/png";
  data_b64: string;
}

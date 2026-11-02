import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import chatObjectSchema from "../../../contracts/chat-object.schema.json";
import commentsObjectSchema from "../../../contracts/comments-object.schema.json";
import cueObjectSchema from "../../../contracts/cue-object.schema.json";
import currentSlideObjectSchema from "../../../contracts/current-slide-object.schema.json";
import deckObjectSchema from "../../../contracts/deck-object.schema.json";
import inkObjectSchema from "../../../contracts/ink-object.schema.json";
import marksObjectSchema from "../../../contracts/marks-object.schema.json";
import outlineObjectSchema from "../../../contracts/outline-object.schema.json";
import pointerObjectSchema from "../../../contracts/pointer-object.schema.json";
import roomCatalogSchema from "../../../contracts/room-catalog.schema.json";
import roomStateObjectSchema from "../../../contracts/room-state-object.schema.json";
import roomStatsSchema from "../../../contracts/room-stats.schema.json";
import slideFrameSchema from "../../../contracts/slide-frame.schema.json";
import slideObjectSchema from "../../../contracts/slide-object.schema.json";
import legacyEnvelopeSchema from "./legacy-envelope.schema.json";
import {
  isCarryRecord,
  type ChatObject,
  type CommentsObject,
  type CueObject,
  type CurrentSlideObject,
  type DeckObject,
  type InkObject,
  type LegacyEnvelope,
  type MarksObject,
  type OutlineObject,
  type PointerObject,
  type RoomCatalog,
  type RunSpan,
  type RoomStateObject,
  type RoomStats,
  type SlideFrame,
  type SlideObject,
} from "./types";

// The schemas are pydantic output (JSON Schema 2020-12: `prefixItems` for ink points). `discriminator`
// with a `mapping` is OpenAPI vocabulary that Ajv's own discriminator support refuses, so it is
// declared as an annotation-only keyword: `oneOf` still does the validating, and the variants differ
// enough (required fields, `kind` constants, additionalProperties) that exactly one matches.
const ajv = new Ajv2020({ allErrors: false, strict: true });
ajv.addKeyword({ keyword: "discriminator", schemaType: "object" });

// Compiling a schema generates code, about 15 ms each: compiling all of them on import was one 250 ms task on every
// player page's load (workstream 06). Each is compiled on its first use instead.
function lazy<T>(schema: object): () => ValidateFunction<T> {
  let validator: ValidateFunction<T> | undefined;
  return () => (validator ??= ajv.compile<T>(schema));
}

const cueObjectValidator = lazy<CueObject>(cueObjectSchema);
const slideObjectValidator = lazy<SlideObject>(slideObjectSchema);
const outlineObjectValidator = lazy<OutlineObject>(outlineObjectSchema);
const deckObjectValidator = lazy<DeckObject>(deckObjectSchema);
const currentSlideObjectValidator = lazy<CurrentSlideObject>(currentSlideObjectSchema);
const inkObjectValidator = lazy<InkObject>(inkObjectSchema);
const marksObjectValidator = lazy<MarksObject>(marksObjectSchema);
const pointerObjectValidator = lazy<PointerObject>(pointerObjectSchema);
const commentsObjectValidator = lazy<CommentsObject>(commentsObjectSchema);
const roomStateObjectValidator = lazy<RoomStateObject>(roomStateObjectSchema);
const chatObjectValidator = lazy<ChatObject>(chatObjectSchema);
const roomStatsValidator = lazy<RoomStats>(roomStatsSchema);
const roomCatalogValidator = lazy<RoomCatalog>(roomCatalogSchema);
const slideFrameValidator = lazy<SlideFrame>(slideFrameSchema);
const legacyValidator = lazy<LegacyEnvelope>(legacyEnvelopeSchema);

// The agents check these too (pydantic model validators); JSON Schema cannot express them.
function timelineConsistent(records: (CueObject | SlideObject)[number][]): string | null {
  for (const [i, r] of records.entries()) {
    if (isCarryRecord(r)) {
      if (i > 0) return "a carry-in note is the first record of object 0";
    } else if ("start" in r.data) {
      if (r.m !== r.data.start) return "a cue record's m is its start";
      if (r.data.end < r.data.start) return "a cue ends before it starts";
    } else if (r.m !== r.data.at) return "a slide record's m is its at";
  }
  return null;
}

function outlineConsistent(records: OutlineObject): string | null {
  for (const r of records) if (r.data.kind === "chapter" && r.m !== r.data.start) return "a chapter's m is its start";
  return null;
}

const backwards = (span: readonly RunSpan[] | null | undefined) =>
  span?.some((s) => s.end != null && s.end < (s.start ?? 0)) ?? false;

function commentsConsistent(records: CommentsObject): string | null {
  for (const { m, data } of records) {
    if (data.kind !== "comment" && data.kind !== "reply") continue;
    if (m < data.at) return "a comment record's m is not before its at";
    if (data.kind === "comment" && backwards(data.anchor.span)) return "a run span ends before it starts";
  }
  return null;
}

function marksConsistent(records: MarksObject): string | null {
  for (const { data } of records) {
    if (data.kind === "mark" && backwards(data.span)) return "a run span ends before it starts";
  }
  return null;
}

function deckConsistent(records: DeckObject): string | null {
  for (const { data } of records) {
    if (data.kind !== "image" || !data.runs) continue;
    if (new Set(data.runs.map((r) => r.id)).size !== data.runs.length) return "run ids repeat within a slide";
  }
  return null;
}

function catalogConsistent(c: RoomCatalog): string | null {
  const slices = [c.tt.E, ...Object.values(c.tt.shift)];
  return slices.every((v) => v % 4000 === 0) ? null : "E and every shift are whole slices";
}

const decoder = new TextDecoder();

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parse<T>(
  compiled: () => ValidateFunction<T>,
  payload: Uint8Array | string,
  check?: (v: T) => string | null,
): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(typeof payload === "string" ? payload : decoder.decode(payload));
  } catch (e) {
    return { ok: false, error: `not JSON: ${String(e)}` };
  }
  const validator = compiled();
  if (!validator(json)) return { ok: false, error: ajv.errorsText(validator.errors) };
  const wrong = check?.(json);
  if (wrong) return { ok: false, error: wrong };
  return { ok: true, value: json };
}

/** An object of a captions or translation items track. */
export function parseCueObject(payload: Uint8Array | string): Parsed<CueObject> {
  return parse(cueObjectValidator, payload, timelineConsistent);
}

/** An object of the slide descriptions' items track. */
export function parseSlideObject(payload: Uint8Array | string): Parsed<SlideObject> {
  return parse(slideObjectValidator, payload, timelineConsistent);
}

/** The object of an outline revision. */
export function parseOutlineObject(payload: Uint8Array | string): Parsed<OutlineObject> {
  return parse(outlineObjectValidator, payload, outlineConsistent);
}

/** An object of talk/<room>/slides track `deck`. */
export function parseDeckObject(payload: Uint8Array | string): Parsed<DeckObject> {
  return parse(deckObjectValidator, payload, deckConsistent);
}

/** An object of talk/<room>/slides track `slide`. */
export function parseCurrentSlideObject(payload: Uint8Array | string): Parsed<CurrentSlideObject> {
  return parse(currentSlideObjectValidator, payload);
}

/** An object of an `ink` track: talk/<room>/slides (the speaker's) or talk/<room>/annotations. */
export function parseInkObject(payload: Uint8Array | string): Parsed<InkObject> {
  return parse(inkObjectValidator, payload);
}

/** An object of a `marks` track: talk/<room>/slides (the speaker's) or talk/<room>/annotations. */
export function parseMarksObject(payload: Uint8Array | string): Parsed<MarksObject> {
  return parse(marksObjectValidator, payload, marksConsistent);
}

/** An object of talk/<room>/slides track `pointer`. */
export function parsePointerObject(payload: Uint8Array | string): Parsed<PointerObject> {
  return parse(pointerObjectValidator, payload);
}

/** An object of talk/<room>/comments track `comments`. */
export function parseCommentsObject(payload: Uint8Array | string): Parsed<CommentsObject> {
  return parse(commentsObjectValidator, payload, commentsConsistent);
}

/** An object of talk/<room>/catalog track `room`. */
export function parseRoomStateObject(payload: Uint8Array | string): Parsed<RoomStateObject> {
  return parse(roomStateObjectValidator, payload);
}

/** An object of talk/<room>/chat track `chat`. */
export function parseChatObject(payload: Uint8Array | string): Parsed<ChatObject> {
  return parse(chatObjectValidator, payload);
}

/** The object of a group of talk/<room>/stats track `stats`. */
export function parseRoomStats(payload: Uint8Array | string): Parsed<RoomStats> {
  return parse(roomStatsValidator, payload);
}

/** Object 0 of a group of talk/<room>/catalog. */
export function parseRoomCatalog(payload: Uint8Array | string): Parsed<RoomCatalog> {
  return parse(roomCatalogValidator, payload, catalogConsistent);
}

export function parseSlideFrame(payload: Uint8Array | string): Parsed<SlideFrame> {
  return parse(slideFrameValidator, payload);
}

export function isSlideFrame(value: unknown): value is SlideFrame {
  return slideFrameValidator()(value);
}

/** @deprecated v1, for the room store and demo script until they move to the event-timeline records. */
export function parseLegacyEnvelope(payload: Uint8Array | string): Parsed<LegacyEnvelope> {
  return parse(legacyValidator, payload);
}

/** @deprecated v1, for the room store and demo script until they move to the event-timeline records. */
export function isLegacyEnvelope(value: unknown): value is LegacyEnvelope {
  return legacyValidator()(value);
}

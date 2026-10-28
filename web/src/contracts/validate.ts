import Ajv, { type ValidateFunction } from "ajv";
import cueObjectSchema from "../../../contracts/cue-object.schema.json";
import outlineObjectSchema from "../../../contracts/outline-object.schema.json";
import roomCatalogSchema from "../../../contracts/room-catalog.schema.json";
import slideFrameSchema from "../../../contracts/slide-frame.schema.json";
import slideObjectSchema from "../../../contracts/slide-object.schema.json";
import legacyEnvelopeSchema from "./legacy-envelope.schema.json";
import {
  isCarryRecord,
  type CueObject,
  type LegacyEnvelope,
  type OutlineObject,
  type RoomCatalog,
  type SlideFrame,
  type SlideObject,
} from "./types";

// The schemas are pydantic output. `discriminator` with a `mapping` is OpenAPI vocabulary that Ajv's
// own discriminator support refuses, so it is declared as an annotation-only keyword: `oneOf` still
// does the validating, and the variants differ enough (required fields, additionalProperties) that
// exactly one matches.
const ajv = new Ajv({ allErrors: false, strict: true });
ajv.addKeyword({ keyword: "discriminator", schemaType: "object" });

const cueObjectValidator: ValidateFunction<CueObject> = ajv.compile<CueObject>(cueObjectSchema);
const slideObjectValidator: ValidateFunction<SlideObject> = ajv.compile<SlideObject>(slideObjectSchema);
const outlineObjectValidator: ValidateFunction<OutlineObject> = ajv.compile<OutlineObject>(outlineObjectSchema);
const roomCatalogValidator: ValidateFunction<RoomCatalog> = ajv.compile<RoomCatalog>(roomCatalogSchema);
const slideFrameValidator: ValidateFunction<SlideFrame> = ajv.compile<SlideFrame>(slideFrameSchema);
const legacyValidator: ValidateFunction<LegacyEnvelope> = ajv.compile<LegacyEnvelope>(legacyEnvelopeSchema);

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

function catalogConsistent(c: RoomCatalog): string | null {
  const slices = [c.tt.E, ...Object.values(c.tt.shift)];
  return slices.every((v) => v % 4000 === 0) ? null : "E and every shift are whole slices";
}

const decoder = new TextDecoder();

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parse<T>(
  validator: ValidateFunction<T>,
  payload: Uint8Array | string,
  check?: (v: T) => string | null,
): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(typeof payload === "string" ? payload : decoder.decode(payload));
  } catch (e) {
    return { ok: false, error: `not JSON: ${String(e)}` };
  }
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

/** Object 0 of a group of talk/<room>/catalog. */
export function parseRoomCatalog(payload: Uint8Array | string): Parsed<RoomCatalog> {
  return parse(roomCatalogValidator, payload, catalogConsistent);
}

export function parseSlideFrame(payload: Uint8Array | string): Parsed<SlideFrame> {
  return parse(slideFrameValidator, payload);
}

export function isSlideFrame(value: unknown): value is SlideFrame {
  return slideFrameValidator(value);
}

/** @deprecated v1, for the room store and demo script until they move to the event-timeline records. */
export function parseLegacyEnvelope(payload: Uint8Array | string): Parsed<LegacyEnvelope> {
  return parse(legacyValidator, payload);
}

/** @deprecated v1, for the room store and demo script until they move to the event-timeline records. */
export function isLegacyEnvelope(value: unknown): value is LegacyEnvelope {
  return legacyValidator(value);
}

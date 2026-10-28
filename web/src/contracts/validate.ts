import Ajv, { type ValidateFunction } from "ajv";
import envelopeSchema from "../../../contracts/envelope.schema.json";
import slideFrameSchema from "../../../contracts/slide-frame.schema.json";
import legacyEnvelopeSchema from "./legacy-envelope.schema.json";
import type { Envelope, LegacyEnvelope, SlideFrame } from "./types";

// The schemas are pydantic output. `discriminator` with a `mapping` is OpenAPI vocabulary that Ajv's
// own discriminator support refuses, so it is declared as an annotation-only keyword: `oneOf` still
// does the validating, and the variants differ enough (required fields, additionalProperties) that
// exactly one matches.
const ajv = new Ajv({ allErrors: false, strict: true });
ajv.addKeyword({ keyword: "discriminator", schemaType: "object" });

const envelopeValidator: ValidateFunction<Envelope> = ajv.compile<Envelope>(envelopeSchema);
const slideFrameValidator: ValidateFunction<SlideFrame> = ajv.compile<SlideFrame>(slideFrameSchema);
const legacyValidator: ValidateFunction<LegacyEnvelope> = ajv.compile<LegacyEnvelope>(legacyEnvelopeSchema);

// The agents check this too (pydantic model validator); JSON Schema cannot tie `kind` to `body.type`.
const KIND_OF_BODY: Record<Envelope["body"]["type"], Envelope["kind"]> = {
  "captions-carry": "carry",
  "translation-carry": "carry",
  "slides-carry": "carry",
  caption: "item",
  translation: "item",
  slide: "item",
  outline: "snapshot",
};

function consistent(e: Envelope): boolean {
  return KIND_OF_BODY[e.body.type] === e.kind && (!e.capped || e.kind === "carry");
}

const decoder = new TextDecoder();

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parse<T>(validator: ValidateFunction<T>, payload: Uint8Array | string, check?: (v: T) => boolean): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(typeof payload === "string" ? payload : decoder.decode(payload));
  } catch (e) {
    return { ok: false, error: `not JSON: ${String(e)}` };
  }
  if (!validator(json)) return { ok: false, error: ajv.errorsText(validator.errors) };
  if (check && !check(json)) return { ok: false, error: "kind does not match the body" };
  return { ok: true, value: json };
}

export function parseEnvelope(payload: Uint8Array | string): Parsed<Envelope> {
  return parse(envelopeValidator, payload, consistent);
}

export function parseSlideFrame(payload: Uint8Array | string): Parsed<SlideFrame> {
  return parse(slideFrameValidator, payload);
}

export function isEnvelope(value: unknown): value is Envelope {
  return envelopeValidator(value) && consistent(value);
}

export function isSlideFrame(value: unknown): value is SlideFrame {
  return slideFrameValidator(value);
}

/** @deprecated v1, for the room store and demo script until they move to Envelope. */
export function parseLegacyEnvelope(payload: Uint8Array | string): Parsed<LegacyEnvelope> {
  return parse(legacyValidator, payload);
}

/** @deprecated v1, for the room store and demo script until they move to Envelope. */
export function isLegacyEnvelope(value: unknown): value is LegacyEnvelope {
  return legacyValidator(value);
}

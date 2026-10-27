import Ajv, { type ValidateFunction } from "ajv";
import envelopeSchema from "../../../contracts/envelope.schema.json";
import slideFrameSchema from "../../../contracts/slide-frame.schema.json";
import type { Envelope, SlideFrame } from "./types";

// The schemas are pydantic output. `discriminator` with a `mapping` is OpenAPI vocabulary that Ajv's
// own discriminator support refuses, so it is declared as an annotation-only keyword: `oneOf` still
// does the validating, and the variants differ enough (required fields, additionalProperties) that
// exactly one matches.
const ajv = new Ajv({ allErrors: false, strict: true });
ajv.addKeyword({ keyword: "discriminator", schemaType: "object" });

const envelopeValidator: ValidateFunction<Envelope> = ajv.compile<Envelope>(envelopeSchema);
const slideFrameValidator: ValidateFunction<SlideFrame> = ajv.compile<SlideFrame>(slideFrameSchema);

const decoder = new TextDecoder();

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parse<T>(validator: ValidateFunction<T>, payload: Uint8Array | string): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(typeof payload === "string" ? payload : decoder.decode(payload));
  } catch (e) {
    return { ok: false, error: `not JSON: ${String(e)}` };
  }
  if (validator(json)) return { ok: true, value: json };
  return { ok: false, error: ajv.errorsText(validator.errors) };
}

export function parseEnvelope(payload: Uint8Array | string): Parsed<Envelope> {
  return parse(envelopeValidator, payload);
}

export function parseSlideFrame(payload: Uint8Array | string): Parsed<SlideFrame> {
  return parse(slideFrameValidator, payload);
}

export function isEnvelope(value: unknown): value is Envelope {
  return envelopeValidator(value);
}

export function isSlideFrame(value: unknown): value is SlideFrame {
  return slideFrameValidator(value);
}

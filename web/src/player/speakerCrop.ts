// Where the speaker is in a demo talk's produced video, over time (demoSpeakerCrops.json, measured from the frames by
// web/scripts/speaker_crops.py). The conference's feed is mostly a slide with the speaker in a small box at the
// bottom right, sometimes the stage camera full frame, sometimes a slide full frame with nobody in it: the camera tile
// shows only the speaker, never the slides, which have a tile of their own.

import { RECORDING_SUFFIX } from "../contracts/names";
import data from "./demoSpeakerCrops.json";

/** [x, y, w, h], fractions of the video frame (as CameraSurface's Rect). */
export type Fraction = readonly [number, number, number, number];

/** [from, to) in lecture ms, and the speaker's rectangle in source pixels then; null: the speaker is off camera. */
export type CropSpan = readonly [number, number, readonly [number, number, number, number] | null];

export interface SpeakerCrops {
  /** The source video's width and height, px: the rectangles are in its pixels. */
  frame: readonly [number, number];
  /** In time order, back to back from lecture 00:00. */
  spans: readonly CropSpan[];
}

const TALKS = (data as unknown as { talks: Record<string, SpeakerCrops> }).talks;

/** A demo talk's crops, for its live session (`<id>`) or its recording (`<id>-recording`); undefined for any other room. */
export function speakerCropsFor(room: string): SpeakerCrops | undefined {
  const id = room.endsWith(RECORDING_SUFFIX) ? room.slice(0, -RECORDING_SUFFIX.length) : room;
  return Object.hasOwn(TALKS, id) ? TALKS[id] : undefined;
}

/**
 * Which span holds lecture time `ms`: its index, or -1 before anything is known (no time yet). Before 00:00 the first
 * span, after the last span's end the last one (the final frame stays).
 */
export function cropSpanAt(crops: SpeakerCrops, ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || crops.spans.length === 0) return -1;
  const { spans } = crops;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid]![0] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const fraction = (crops: SpeakerCrops, r: readonly [number, number, number, number]): Fraction => {
  const [fw, fh] = crops.frame;
  return [r[0] / fw, r[1] / fh, r[2] / fw, r[3] / fh];
};

/**
 * What the camera tile shows at span `index`: the speaker's rectangle (fractions of the frame), or off camera with the
 * rectangle the tile keeps its shape from (the nearest span's that has the speaker, earlier first).
 */
export function speakerAt(crops: SpeakerCrops, index: number): { region: Fraction; off: boolean } | undefined {
  const { spans } = crops;
  if (index < 0 || index >= spans.length) return undefined;
  const own = spans[index]![2];
  if (own) return { region: fraction(crops, own), off: false };
  for (let d = 1; d < spans.length; d++) {
    const near = spans[index - d]?.[2] ?? spans[index + d]?.[2];
    if (near) return { region: fraction(crops, near), off: true };
  }
  return undefined;
}

/** The tile's shape before the time is known: the talk's first speaker rectangle's (width / height, source pixels). */
export function speakerAspect(crops: SpeakerCrops): number | undefined {
  const r = crops.spans.find((s) => s[2])?.[2];
  return r ? r[2] / r[3] : undefined;
}

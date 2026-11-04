// Build the lecture package (ticket 0023, wiki/spec/lecture-package.md): read the talk's slides by FETCH, draw
// each with its final ink, lay out the files and write the .zip, all in the browser. The transcripts and the
// outline come in already gathered (the Download popover holds their subscriptions while it runs). Loaded on demand
// from the Download popover, so none of this is in the player's first bundle.

import { type InkElement, SLICE_MS, type TextMark } from "../contracts/types";
import type { TranscriptLanguage } from "../player/transcriptExport";
import type { HistorySource } from "../playback/source";
import type { Outline, SlideItem } from "../playback/wire";
import { lectureFiles, type PackageSlide, slideText } from "./lecture";
import { renderSlidePng, type SlideRenderer } from "./render";
import { type GatheredSlide, gatherSlides, type SlidesGathered } from "./slides";
import { zipBlob, type ZipEntry } from "./zip";

export interface PackageProgress {
  /** What is happening, for the status line. */
  label: string;
  /** 0..1 over the whole build. */
  fraction: number;
}

export interface BuildPackageInput {
  /** Where the slide tracks are read; undefined when the room has none. */
  source: HistorySource | undefined;
  room: string;
  title: string;
  speaker: string | undefined;
  live: boolean;
  /** Room ms. */
  fromMs: number;
  toMs: number;
  talkMs: (ms: number) => number;
  languages: readonly TranscriptLanguage[];
  outline: Outline | undefined;
  /**
   * The listener's author id on the audience track: their own ink and text marks go in a second picture per slide.
   * Undefined when they have none to read (no room service identity).
   */
  mine?: string;
  /** The describe agent's slide descriptions, gathered only when that costs nothing (package/languages.ts). */
  descriptions?: readonly SlideItem[];
  leftOut: readonly string[];
  signal?: AbortSignal;
  onProgress?: (p: PackageProgress) => void;
  /** Draws a slide to PNG; the browser's canvas by default. */
  render?: SlideRenderer;
  createdAt?: Date;
  fetchTimeoutMs?: number;
}

export interface BuiltPackage {
  fileName: string;
  blob: Blob;
  entries: ZipEntry[];
}

/** The share of the progress bar each step takes. */
const STEPS = { slides: [0, 0.6], drawing: [0.6, 0.95], zip: [0.95, 1] } as const;

export function packageFileName(room: string): string {
  const safe = room.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "talk";
  return `${safe}-lecture.zip`;
}

/**
 * A slide's description: the describe agent's newest for its position in the deck. The agent knows a slide by its
 * index alone, so with more than one deck it must also have been written while the slide was on screen.
 */
export function describedAs(
  s: Pick<GatheredSlide, "index" | "shown">,
  descriptions: readonly SlideItem[],
  manyDecks: boolean,
): string | undefined {
  const during = (at: number) => s.shown.some((x) => at >= x.fromMs - SLICE_MS && at < x.toMs);
  const found = descriptions.filter((d) => d.id === s.index && d.description.trim() && (!manyDecks || during(d.atMs)));
  return found.at(-1)?.description.trim();
}

export async function buildLecturePackage(input: BuildPackageInput): Promise<BuiltPackage> {
  const { signal, onProgress } = input;
  const report = (label: string, step: keyof typeof STEPS, f: number) => {
    const [a, b] = STEPS[step];
    onProgress?.({ label, fraction: a + (b - a) * Math.min(1, Math.max(0, f)) });
  };

  let gathered: SlidesGathered = { decks: [], slides: [], missingGroups: 0 };
  if (input.source) {
    report("Reading the slides…", "slides", 0);
    gathered = await gatherSlides({
      source: input.source,
      room: input.room,
      fromMs: input.fromMs,
      toMs: input.toMs,
      signal,
      fetchTimeoutMs: input.fetchTimeoutMs,
      mine: input.mine,
      onProgress: ({ done, total }) => report("Reading the slides…", "slides", total ? done / total : 1),
    });
  }
  signal?.throwIfAborted();

  const render = input.render ?? renderSlidePng;
  const draw = async (s: GatheredSlide, ink: readonly InkElement[], marks: readonly TextMark[]) => {
    try {
      return await render({ image: s.image, aspect: aspect.get(s.deck) ?? 16 / 9, ink, marks });
    } catch (err) {
      console.warn(`lecture package: slide ${s.index + 1} could not be drawn`, err);
      return undefined;
    }
  };
  const aspect = new Map(gathered.decks.map((d) => [d.deck, d.info?.aspect ?? 16 / 9] as const));
  const manyDecks = new Set(gathered.slides.map((s) => s.deck)).size > 1;
  const slides: PackageSlide[] = [];
  for (const [i, s] of gathered.slides.entries()) {
    signal?.throwIfAborted();
    report(`Drawing slide ${i + 1} of ${gathered.slides.length}…`, "drawing", i / gathered.slides.length);
    const png = await draw(s, s.ink, s.marks);
    // The listener's own annotations, over the speaker's, in a second picture: only when they made any.
    const mine = s.mine.ink.length || s.mine.marks.length ? s.mine : undefined;
    const minePng = mine ? await draw(s, [...s.ink, ...mine.ink], [...s.marks, ...mine.marks]) : undefined;
    slides.push({
      number: s.index + 1,
      deck: s.deck,
      text: slideText(s.image?.runs),
      shown: s.shown,
      ink: s.ink.length,
      marks: s.marks.length,
      png,
      mine: mine ? { ink: mine.ink.length, marks: mine.marks.length, png: minePng } : undefined,
      description: describedAs(s, input.descriptions ?? [], manyDecks),
    });
  }
  signal?.throwIfAborted();

  report("Writing the zip…", "zip", 0);
  const createdAt = input.createdAt ?? new Date();
  const entries = lectureFiles({
    title: input.title,
    speaker: input.speaker,
    room: input.room,
    createdAt,
    fromMs: input.fromMs,
    toMs: input.toMs,
    live: input.live,
    talkMs: input.talkMs,
    languages: input.languages,
    outline: input.outline,
    slides,
    leftOut: input.leftOut,
    descriptions: input.descriptions !== undefined,
  });
  const blob = zipBlob(entries, createdAt);
  report("Done", "zip", 1);
  return { fileName: packageFileName(input.room), blob, entries };
}

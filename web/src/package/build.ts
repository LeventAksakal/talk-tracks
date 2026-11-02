// Build the lecture package (ticket 0023, wiki/spec/lecture-package.md): read the talk's slides by FETCH, draw
// each with its final ink, lay out the files and write the .zip, all in the browser. The transcripts and the
// outline come in already gathered (the Download popover holds their subscriptions while it runs). Loaded on demand
// from the Download popover, so none of this is in the player's first bundle.

import type { TranscriptLanguage } from "../player/transcriptExport";
import type { Note } from "../player/notes";
import type { HistorySource } from "../playback/source";
import type { Outline } from "../playback/wire";
import { lectureFiles, type PackageSlide, slideText } from "./lecture";
import { renderSlidePng, type SlideRenderer } from "./render";
import { gatherSlides, type SlidesGathered } from "./slides";
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
  notes: readonly Note[];
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
      onProgress: ({ done, total }) => report("Reading the slides…", "slides", total ? done / total : 1),
    });
  }
  signal?.throwIfAborted();

  const render = input.render ?? renderSlidePng;
  const aspect = new Map(gathered.decks.map((d) => [d.deck, d.info?.aspect ?? 16 / 9] as const));
  const slides: PackageSlide[] = [];
  for (const [i, s] of gathered.slides.entries()) {
    signal?.throwIfAborted();
    report(`Drawing slide ${i + 1} of ${gathered.slides.length}…`, "drawing", i / gathered.slides.length);
    let png: Uint8Array | undefined;
    try {
      png = await render({ image: s.image, aspect: aspect.get(s.deck) ?? 16 / 9, ink: s.ink, marks: s.marks });
    } catch (err) {
      console.warn(`lecture package: slide ${s.index + 1} could not be drawn`, err);
    }
    slides.push({
      number: s.index + 1,
      deck: s.deck,
      text: slideText(s.image?.runs),
      shown: s.shown,
      ink: s.ink.length,
      marks: s.marks.length,
      png,
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
    notes: input.notes,
    leftOut: input.leftOut,
  });
  const blob = zipBlob(entries, createdAt);
  report("Done", "zip", 1);
  return { fileName: packageFileName(input.room), blob, entries };
}

// The offline demo's slides (/demo): a scripted deck shown a slide every 30 s (in step with the demo's describe
// agent), the speaker's pen, highlighter, text marks and laser on each slide, a listener's ink and marks through
// the "room service", and the room on air. Published on a FakeHistorySource the way the console (live) and the
// room service (live, and the archive on talk/<room>/archive/slides) would, so the player reads it exactly as it
// reads a real room: SUBSCRIBE live, FETCH one group per track to rewind.

import {
  annotationsPath,
  catalogPath,
  DECK_TRACK,
  INK_TRACK,
  MARKS_TRACK,
  POINTER_TRACK,
  ROOM_TRACK,
  SLIDE_TRACK,
  slidesPath,
} from "../contracts/names";
import { currentSlide, inkCarry, lastRecord, marksCarry } from "../contracts/tracks";
import type {
  Author,
  CatalogTrack,
  CurrentSlideRecord,
  DeckImage,
  DeckRecord,
  InkRecord,
  MarkRecord,
  Point,
  PointerRecord,
  Region,
  RoomCatalog,
  RoomStateRecord,
  TextRun,
} from "../contracts/types";
import { FakeHistorySource } from "../playback/fakeSource";
import { SLICE_MS, sliceOf } from "../playback/slices";
import { historyPath } from "./slideTracks";

/** A slide every 30 s from 2 s, as the demo's describe agent describes them. */
export const DEMO_FIRST_SLIDE_MS = 2_000;
export const DEMO_SLIDE_MS = 30_000;

const W = 960;
const H = 540;

const SLIDES: { title: string; bullets: [string, string, string] }[] = [
  {
    title: "How rivers shape the land",
    bullets: ["Water moves rock and soil", "Valleys are cut over time", "Deltas grow where rivers slow"],
  },
  {
    title: "Erosion",
    bullets: ["Fast water picks up stones", "Stones grind the riverbed", "Canyons deepen every year"],
  },
  {
    title: "The Grand Canyon",
    bullets: ["Cut by the Colorado River", "Nearly two kilometres deep", "Layers record millions of years"],
  },
  {
    title: "Deposition",
    bullets: ["Slow water drops its load", "Sand settles first, then silt", "Plains grow with every flood"],
  },
  {
    title: "Deltas",
    bullets: ["Where a river meets the sea", "Sediment fans out in channels", "Fertile land for farming"],
  },
  {
    title: "Floods",
    bullets: ["A year of sediment in a day", "New channels open up", "Banks are built higher"],
  },
  {
    title: "Meanders",
    bullets: ["The outer bank wears away", "The inner bank collects sand", "Loops cut off into lakes"],
  },
  { title: "Wrap-up", bullets: ["Fast water wears land down", "Slow water builds it up", "Rivers redraw the map"] },
];

const SPEAKER: Author = { id: "speaker", name: "Demo speaker", speaker: true };
const LISTENER: Author = { id: "u-ada", name: "Ada" };

const TITLE_FONT = { size: 46, weight: "bold", baseline: 104, x: 64 };
const BULLET_FONT = { size: 30, weight: "normal", baseline: 236, x: 104, step: 72 };
const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

interface Laid {
  runs: TextRun[];
  /** Runs of the title, then of each bullet. */
  lines: TextRun[][];
}

type Measure = (text: string, size: number, weight: string) => number;

/** Words as text runs (ids t1, t2, … in reading order), each with its box in fractions of the slide. */
function layOut(slide: (typeof SLIDES)[number], measure: Measure): Laid {
  const lines: TextRun[][] = [];
  let n = 0;
  const line = (text: string, font: { size: number; weight: string }, x0: number, baseline: number) => {
    const space = measure(" ", font.size, font.weight);
    let x = x0;
    const runs: TextRun[] = [];
    for (const word of text.split(" ")) {
      const w = measure(word, font.size, font.weight);
      const top = baseline - font.size * 0.92;
      runs.push({ id: `t${++n}`, text: word, box: frac({ x, y: top, w, h: font.size * 1.18 }) });
      x += w + space;
    }
    lines.push(runs);
  };
  line(slide.title, TITLE_FONT, TITLE_FONT.x, TITLE_FONT.baseline);
  slide.bullets.forEach((b, j) => line(b, BULLET_FONT, BULLET_FONT.x, BULLET_FONT.baseline + j * BULLET_FONT.step));
  return { runs: lines.flat(), lines };
}

function frac(r: Region): Region {
  const c = (v: number) => Math.min(1, Math.max(0, Math.round(v * 10_000) / 10_000));
  return { x: c(r.x / W), y: c(r.y / H), w: c(r.w / W), h: c(r.h / H) };
}

/** A transparent 1×1 PNG, for where no canvas can draw the slides (tests). */
const BLANK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

function canvas2d(): CanvasRenderingContext2D | null {
  try {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return c.getContext("2d");
  } catch {
    return null;
  }
}

/** The deck's images and text runs, drawn on a canvas where there is one. */
export function demoDeck(): { images: DeckImage[]; laid: Laid[] } {
  const ctx = canvas2d();
  const measure: Measure = ctx
    ? (text, size, weight) => {
        ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
        return ctx.measureText(text).width;
      }
    : (text, size) => text.length * size * 0.52;
  const laid = SLIDES.map((s) => layOut(s, measure));
  const images = SLIDES.map((slide, index): DeckImage => {
    const data = ctx ? drawSlide(ctx, slide, index) : BLANK_PNG;
    return { kind: "image", index, mime: "image/png", width: W, height: H, data_b64: data, runs: laid[index]!.runs };
  });
  return { images, laid };
}

function drawSlide(ctx: CanvasRenderingContext2D, slide: (typeof SLIDES)[number], index: number): string {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#f7f5ef";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#2f6fb5";
  ctx.fillRect(0, 0, W, 10);
  // Land and a river in the lower right, for the ink and the laser to point at.
  ctx.fillStyle = "#cfe3c4";
  ctx.beginPath();
  ctx.moveTo(560, H);
  ctx.quadraticCurveTo(700, 330, 960, 300);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#4a90d9";
  ctx.lineWidth = 16 + index * 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(640, H + 10);
  ctx.bezierCurveTo(700, 450, 860, 470, 820, 400);
  ctx.bezierCurveTo(790, 350, 900, 330, 950, 320);
  ctx.stroke();
  ctx.fillStyle = "#1b2a41";
  ctx.font = `${TITLE_FONT.weight} ${TITLE_FONT.size}px ${FONT_FAMILY}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(slide.title, TITLE_FONT.x, TITLE_FONT.baseline);
  ctx.fillStyle = "#2f6fb5";
  ctx.fillRect(TITLE_FONT.x, TITLE_FONT.baseline + 22, 120, 4);
  ctx.font = `${BULLET_FONT.weight} ${BULLET_FONT.size}px ${FONT_FAMILY}`;
  slide.bullets.forEach((b, j) => {
    const y = BULLET_FONT.baseline + j * BULLET_FONT.step;
    ctx.fillStyle = "#2f6fb5";
    ctx.beginPath();
    ctx.arc(BULLET_FONT.x - 22, y - 10, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#333a45";
    ctx.fillText(b, BULLET_FONT.x, y);
  });
  ctx.fillStyle = "#8a909c";
  ctx.font = `normal 18px ${FONT_FAMILY}`;
  ctx.fillText(`${index + 1} / ${SLIDES.length}`, W - 80, H - 24);
  return ctx.canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

type Rec = { m: number; data: unknown };

export interface DemoScript {
  deck: DeckRecord[];
  slide: CurrentSlideRecord[];
  ink: InkRecord[];
  marks: MarkRecord[];
  pointer: PointerRecord[];
  audienceInk: InkRecord[];
  audienceMarks: MarkRecord[];
  room: RoomStateRecord[];
}

const box = (runs: readonly TextRun[]): Region => {
  const x = Math.min(...runs.map((r) => r.box.x));
  const y = Math.min(...runs.map((r) => r.box.y));
  const r = Math.max(...runs.map((r) => r.box.x + r.box.w));
  const b = Math.max(...runs.map((r) => r.box.y + r.box.h));
  return { x, y, w: r - x, h: b - y };
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, Math.round(v * 10_000) / 10_000));
const pt = (x: number, y: number): Point => [clamp01(x), clamp01(y)];

/** Every record of every track for a talk of `durationMs`, in room time. */
export function demoScript(laid: readonly Laid[], images: readonly DeckImage[], durationMs: number): DemoScript {
  const s: DemoScript = {
    deck: [
      { m: 0, data: { kind: "deck", count: images.length, aspect: W / H, title: "How rivers shape the land" } },
      ...images.map((data) => ({ m: 0, data })),
    ],
    slide: [],
    ink: [],
    marks: [],
    pointer: [],
    audienceInk: [],
    audienceMarks: [],
    room: [
      { m: 0, data: { kind: "state", state: "on_air", title: "How rivers shape the land", speaker: "Demo speaker" } },
    ],
  };

  const draw = (
    into: InkRecord[],
    id: string,
    from: number,
    ms: number,
    points: Point[],
    style: { index: number; tool: "pen" | "highlighter"; color: string; width: number; by: Author },
  ) => {
    // begin with the first point, then a batch every 80 ms, then end: points arrive as they are drawn.
    const batches = Math.max(1, Math.round(ms / 80));
    const per = Math.ceil((points.length - 1) / batches);
    into.push({ m: from, data: { kind: "begin", stroke: id, deck: 0, points: points.slice(0, 1), ...style } });
    for (let b = 0; b * per + 1 < points.length; b++) {
      const chunk = points.slice(1 + b * per, 1 + (b + 1) * per);
      into.push({ m: from + (b + 1) * 80, data: { kind: "points", stroke: id, points: chunk } });
    }
    into.push({ m: from + (batches + 1) * 80, data: { kind: "end", stroke: id } });
  };
  const laser = (from: number, ms: number, at: (f: number) => [number, number]) => {
    for (let dt = 0; dt <= ms; dt += 50) {
      const [x, y] = at(dt / ms);
      s.pointer.push({ m: from + dt, data: { kind: "at", x: clamp01(x), y: clamp01(y) } });
    }
    s.pointer.push({ m: from + ms + 50, data: { kind: "off" } });
  };

  for (let n = 0, S = DEMO_FIRST_SLIDE_MS; S < durationMs; n++, S += DEMO_SLIDE_MS) {
    const index = n % laid.length;
    const lines = laid[index]!.lines;
    const [titleRuns, b1, b2, b3] = [lines[0]!, lines[1]!, lines[2]!, lines[3]!];
    const title = box(titleRuns);
    const where = { index, by: SPEAKER };
    s.slide.push({ m: S, data: { kind: "show", deck: 0, index } });

    // The laser runs along the title, then circles the river.
    laser(S + 1_500, 1_600, (f) => [title.x + title.w * f, title.y + title.h * 0.6]);
    laser(S + 24_000, 3_000, (f) => [0.84 + 0.07 * Math.cos(f * 4 * Math.PI), 0.74 + 0.12 * Math.sin(f * 4 * Math.PI)]);

    // A pen ellipse round the title, erased later.
    const cx = title.x + title.w / 2;
    const cy = title.y + title.h / 2;
    const ring = Array.from({ length: 33 }, (_, i) => {
      const a = -Math.PI / 2 + (i / 32) * Math.PI * 2.08;
      return pt(cx + (title.w / 2 + 0.03) * Math.cos(a), cy + (title.h / 2 + 0.035) * Math.sin(a));
    });
    draw(s.ink, `sp${n}a`, S + 5_000, 1_200, ring, { ...where, tool: "pen", color: "#e5484d", width: 0.005 });
    s.marks.push({
      m: S + 9_000,
      data: {
        kind: "mark",
        id: `sp${n}m1`,
        deck: 0,
        index,
        style: "underline",
        color: "#e5484d",
        span: titleRuns.map((r) => ({ run: r.id })),
        by: SPEAKER,
      },
    });
    // The highlighter along the second bullet.
    const second = box(b2);
    const sweep = Array.from({ length: 13 }, (_, i) =>
      pt(second.x + (second.w * i) / 12, second.y + second.h * (0.6 + 0.03 * Math.sin(i))),
    );
    draw(s.ink, `sp${n}b`, S + 12_000, 1_000, sweep, { ...where, tool: "highlighter", color: "#ffd400", width: 0.03 });

    // A listener highlights the start of the first bullet and ticks the third (through the room service).
    s.audienceMarks.push({
      m: S + 15_000,
      data: {
        kind: "mark",
        id: `u-ada-${n}m`,
        deck: 0,
        index,
        style: "highlight",
        color: "#4dabf7",
        span: b1.slice(0, 2).map((r) => ({ run: r.id })),
        by: LISTENER,
      },
    });
    const third = box(b3);
    const tx = third.x + third.w + 0.03;
    const ty = third.y + third.h * 0.55;
    const tick = [
      pt(tx, ty),
      pt(tx + 0.012, ty + 0.03),
      pt(tx + 0.024, ty + 0.045),
      pt(tx + 0.045, ty - 0.01),
      pt(tx + 0.07, ty - 0.06),
    ];
    draw(s.audienceInk, `u-ada-${n}k`, S + 17_000, 500, tick, {
      index,
      by: LISTENER,
      tool: "pen",
      color: "#2f9e44",
      width: 0.006,
    });

    // The speaker highlights part of the third bullet: from its second word to the third letter of its third.
    const [, w2, w3] = b3;
    if (w2 && w3)
      s.marks.push({
        m: S + 19_000,
        data: {
          kind: "mark",
          id: `sp${n}m2`,
          deck: 0,
          index,
          style: "highlight",
          color: "#ffd400",
          span: [{ run: w2.id }, { run: w3.id, start: 0, end: Math.min(3, w3.text.length) }],
          by: SPEAKER,
        },
      });
    s.ink.push({ m: S + 22_000, data: { kind: "erase", strokes: [`sp${n}a`], by: SPEAKER } });

    // Before the next slide the speaker clears this one, the listener's annotations too (moderation).
    const end = S + DEMO_SLIDE_MS - 500;
    s.ink.push({ m: end, data: { kind: "clear", deck: 0, index, by: SPEAKER } });
    s.marks.push({ m: end, data: { kind: "clear", deck: 0, index, by: SPEAKER } });
    s.audienceInk.push({ m: end, data: { kind: "clear", deck: 0, index, by: SPEAKER } });
    s.audienceMarks.push({ m: end, data: { kind: "clear", deck: 0, index, by: SPEAKER } });
  }
  for (const list of [s.slide, s.ink, s.marks, s.pointer, s.audienceInk, s.audienceMarks])
    list.sort((a, b) => a.m - b.m);
  return s;
}

type Key = "slide" | "ink" | "marks" | "pointer" | "audienceInk" | "audienceMarks" | "room";

interface Track {
  key: Key;
  path: string;
  /** Where the archive serves it: the speaker's tracks on talk/<room>/archive/slides, the room service's on their own name. */
  history: string;
  name: string;
  /** Object 0 of each slice (the carry-in), and the slice's records. */
  carries: Rec[][];
  deltas: Map<number, Rec[]>;
}

const encoder = new TextEncoder();
const encode = (records: readonly Rec[]) => encoder.encode(JSON.stringify(records));

/** The room catalog's entries for these tracks, so the player knows the room has them. */
export function demoSlidesCatalog(room: string): RoomCatalog {
  const t = (namespace: string, name: string, eventType: string, label: string): CatalogTrack => ({
    namespace,
    name,
    packaging: "eventtimeline",
    eventType,
    label,
    tt: { latenessMs: 0, cost: "free" },
  });
  const slides = slidesPath(room);
  return {
    tracks: [
      t(slides, DECK_TRACK, "com.talktracks.deck", "Slide deck"),
      t(slides, SLIDE_TRACK, "com.talktracks.current-slide", "Slide shown"),
      t(slides, INK_TRACK, "com.talktracks.ink", "Ink"),
      t(slides, MARKS_TRACK, "com.talktracks.marks", "Text marks"),
      t(slides, POINTER_TRACK, "com.talktracks.pointer", "Laser pointer"),
      t(annotationsPath(room), INK_TRACK, "com.talktracks.ink", "Audience ink"),
      t(annotationsPath(room), MARKS_TRACK, "com.talktracks.marks", "Audience text marks"),
      t(catalogPath(room), ROOM_TRACK, "com.talktracks.room", "Room"),
    ],
    tt: { E: 0, shift: {} },
  };
}

/**
 * The demo room's slide tracks on a FakeHistorySource: start it at a room time (every slice before it archived,
 * the current one live), then advance it with the room clock.
 */
export class DemoSlides {
  readonly source: FakeHistorySource;
  readonly room: string;
  readonly catalog: RoomCatalog;
  readonly script: DemoScript;
  #tracks: Track[];
  #open = 0;
  #sent = new Map<Key, { k: number; i: number }>();
  #mirror = new Map<Key, { k: number; objects: Uint8Array[] }>();
  #now = 0;

  constructor(room: string, durationMs: number, source = new FakeHistorySource()) {
    this.room = room;
    this.source = source;
    this.catalog = demoSlidesCatalog(room);
    const { images, laid } = demoDeck();
    this.script = demoScript(laid, images, durationMs);
    const slides = slidesPath(room);
    const slices = sliceOf(durationMs) + 1;
    const bySlice = (records: readonly Rec[]) => {
      const out = new Map<number, Rec[]>();
      for (const r of records) {
        const k = sliceOf(r.m);
        out.set(k, [...(out.get(k) ?? []), r]);
      }
      return out;
    };
    const slideDeltas = bySlice(this.script.slide);
    // Object 0 of slice k = the reducer over object 0 and the deltas of k − 1 (container-formats §1).
    const slideCarry: CurrentSlideRecord[][] = [[]];
    for (let k = 1; k < slices; k++)
      slideCarry.push(lastRecord([...slideCarry[k - 1]!, ...((slideDeltas.get(k - 1) ?? []) as CurrentSlideRecord[])]));
    const on = (k: number) => currentSlide(slideCarry[k] ?? []);
    const carried = (records: readonly Rec[], reduce: (prev: Rec[], k: number) => Rec[]) => {
      const deltas = bySlice(records);
      const carries: Rec[][] = [[]];
      for (let k = 1; k < slices; k++) carries.push(reduce([...carries[k - 1]!, ...(deltas.get(k - 1) ?? [])], k));
      return { carries, deltas };
    };
    const ink = (records: readonly Rec[]) => carried(records, (r, k) => inkCarry(r as InkRecord[], on(k)));
    const marks = (records: readonly Rec[]) => carried(records, (r, k) => marksCarry(r as MarkRecord[], on(k)));
    const last = (records: readonly Rec[]) => carried(records, (r) => lastRecord(r));
    const track = (key: Key, path: string, history: string, name: string, c: ReturnType<typeof last>): Track => ({
      key,
      path,
      history,
      name,
      ...c,
    });
    const archive = historyPath(slides);
    this.#tracks = [
      track("slide", slides, archive, SLIDE_TRACK, { carries: slideCarry, deltas: slideDeltas }),
      track("ink", slides, archive, INK_TRACK, ink(this.script.ink)),
      track("marks", slides, archive, MARKS_TRACK, marks(this.script.marks)),
      track("pointer", slides, archive, POINTER_TRACK, last(this.script.pointer)),
      track("audienceInk", annotationsPath(room), annotationsPath(room), INK_TRACK, ink(this.script.audienceInk)),
      track(
        "audienceMarks",
        annotationsPath(room),
        annotationsPath(room),
        MARKS_TRACK,
        marks(this.script.audienceMarks),
      ),
      track("room", catalogPath(room), catalogPath(room), ROOM_TRACK, last(this.script.room)),
    ];
  }

  /** Objects of slice k of a track, each with the room time it goes out at. */
  #objects(t: Track, k: number): { at: number; records: Rec[] }[] {
    const carry = { at: k * SLICE_MS, records: t.carries[k] ?? [] };
    return [carry, ...(t.deltas.get(k) ?? []).map((r) => ({ at: r.m, records: [r] }))];
  }

  /** Announce the broadcasts and put the room at room time `ms`: history archived, the deck and current slice live. */
  start(ms: number): void {
    const slides = slidesPath(this.room);
    const archive = historyPath(slides);
    for (const path of [slides, archive, annotationsPath(this.room), catalogPath(this.room)])
      this.source.announce(path);
    const deck = this.script.deck.map((r) => encode([r]));
    deck.forEach((payload) => this.source.publish(slides, DECK_TRACK, 0, payload));
    this.source.store(archive, DECK_TRACK, 0, deck);
    const current = sliceOf(ms);
    for (const t of this.#tracks)
      for (let k = 0; k < current; k++)
        this.source.store(
          t.history,
          t.name,
          k,
          this.#objects(t, k).map((o) => encode(o.records)),
        );
    this.#open = current;
    this.#now = ms;
    this.#emit(ms);
  }

  /** Room time runs to `ms`: whatever was made by then goes out live (and into the archive). */
  advanceTo(ms: number): void {
    if (ms <= this.#now) return;
    this.#now = ms;
    this.#emit(ms);
  }

  #emit(ms: number): void {
    for (const t of this.#tracks) {
      let cursor = this.#sent.get(t.key) ?? { k: this.#open, i: 0 };
      for (let k = cursor.k; k <= sliceOf(ms); k++) {
        const objects = this.#objects(t, k);
        let i = k === cursor.k ? cursor.i : 0;
        for (; i < objects.length && objects[i]!.at <= ms; i++) {
          const payload = encode(objects[i]!.records);
          this.source.publish(t.path, t.name, k, payload);
          if (t.history === t.path) continue;
          // The room service mirrors the speaker's tracks into the archive as they arrive (decision 0022).
          const mirror = this.#mirror.get(t.key);
          const held = mirror?.k === k ? mirror.objects : [];
          held.push(payload);
          this.#mirror.set(t.key, { k, objects: held });
          this.source.store(t.history, t.name, k, held);
        }
        cursor = { k, i };
        if (i < objects.length) break;
      }
      this.#sent.set(t.key, cursor);
    }
  }
}

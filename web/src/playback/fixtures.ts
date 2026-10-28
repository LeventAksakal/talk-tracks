// A scripted talk published the way agents publish under decision 0012: captions (interim, then final),
// a Turkish translation that lands a little later, slide descriptions, and an outline revised as
// chapters start. Every slice before the viewer arrives sits in the origin's archive (FETCH only);
// from then on objects go out live as their production time passes. Drives tests and the offline demo.

import type { FakeHistorySource } from "./fakeSource";
import { sliceOf, sliceStart } from "./slices";
import {
  agentPath,
  encodeCarry,
  encodeItem,
  encodeOutline,
  type EncodeOptions,
  type Item,
  ITEMS_TRACK,
  type LineItem,
  type Outline,
  OUTLINE_TRACK,
  type SlideItem,
} from "./wire";

const SENTENCES: [string, string][] = [
  [
    "Welcome, everyone. Today we look at how rivers shape the land.",
    "Herkese hoş geldiniz. Bugün nehirlerin araziyi nasıl şekillendirdiğine bakıyoruz.",
  ],
  ["Water picks up small stones and carries them downstream.", "Su küçük taşları alır ve akış yönünde taşır."],
  [
    "Over thousands of years, this cuts deep valleys into rock.",
    "Binlerce yıl içinde bu, kayalara derin vadiler oyar.",
  ],
  ["On this slide you can see the Grand Canyon from above.", "Bu slaytta Büyük Kanyon'u yukarıdan görebilirsiniz."],
  ["Where the river slows down, it drops what it carried.", "Nehrin yavaşladığı yerde taşıdıklarını bırakır."],
  ["That is how deltas and fertile plains are built.", "Deltalar ve verimli ovalar böyle oluşur."],
  [
    "Floods move more sediment in a day than a quiet year.",
    "Seller bir günde sakin bir yıldan daha fazla tortu taşır.",
  ],
  ["Meanders form where the outer bank erodes faster.", "Menderesler dış kıyının daha hızlı aşındığı yerlerde oluşur."],
];

const CHAPTER_TITLES = ["Introduction", "Erosion", "Deposition", "Floods and meanders", "Wrap-up"];

export interface FakeTalk {
  durationMs: number;
  captions: LineItem[];
  translation: LineItem[];
  slides: SlideItem[];
  /** Outline revisions: when each was produced, and the outline then. */
  outlines: { atMs: number; outline: Outline }[];
}

/** A deterministic talk: a line every 4.5 s (3.6 s of speech), a slide every 30 s, a chapter every 60 s. */
export function fakeTalk(durationMs = 300_000): FakeTalk {
  const captions: LineItem[] = [];
  const translation: LineItem[] = [];
  for (let id = 0, t = 1_000; t + 3_600 <= durationMs; id++, t += 4_500) {
    const [en, tr] = SENTENCES[id % SENTENCES.length]!;
    captions.push({ type: "line", id, startMs: t, endMs: t + 3_600, text: `${en} (${id})`, final: true });
    translation.push({ type: "line", id, startMs: t, endMs: t + 3_600, text: `${tr} (${id})`, final: true });
  }
  const slides: SlideItem[] = [];
  for (let id = 0, t = 2_000; t < durationMs; id++, t += 30_000)
    slides.push({
      type: "slide",
      id,
      atMs: t,
      description: `Slide ${id + 1}: a diagram of a river at stage ${id + 1}.`,
    });
  const outlines: FakeTalk["outlines"] = [];
  const chapters: Outline["chapters"] = [];
  for (let id = 0, t = 0; t < durationMs; id++, t += 60_000) {
    chapters.push({
      id,
      start_ms: t + 1_000,
      title: CHAPTER_TITLES[id % CHAPTER_TITLES.length]!,
      summary: `What chapter ${id + 1} covers.`,
    });
    outlines.push({
      atMs: t + 8_000,
      outline: {
        lang: "en",
        chapters: [...chapters],
        glossary: [{ term: "Sediment", definition: "Sand and stones a river carries." }],
        recap: `So far: ${chapters.map((c) => c.title.toLowerCase()).join(", ")}.`,
      },
    });
  }
  return { durationMs, captions, translation, slides, outlines };
}

interface AgentScript {
  agent: string;
  /** Carry-in and items for slice k, in object order. */
  slice: (k: number) => { atMs: number; payload: Uint8Array }[];
  track: string;
  /** For the outline: revisions, one group each. */
  snapshots?: { atMs: number; group: number; payload: Uint8Array }[];
}

const CAPTION_LATENCY_MS = 400;
const TRANSLATE_LATENCY_MS = 1_800;
const DESCRIBE_LATENCY_MS = 2_500;

export interface FakeRoomOptions {
  /** Slices an agent never produced (it was idle): FETCH finds nothing. */
  neverProduced?: Partial<Record<string, number[]>>;
  /** Slices that came out capped: a carry-in with `capped` and no items. */
  capped?: Partial<Record<string, number[]>>;
}

/**
 * A room whose agents publish `talk`: start it at a media time, then advance the clock. Slices before
 * the start are in the origin's archive only; the current one and later ones go out live.
 */
export class FakeRoom {
  readonly room: string;
  readonly talk: FakeTalk;
  #source: FakeHistorySource;
  #scripts: AgentScript[];
  #now = 0;
  /** The first slice that may still have objects to send. */
  #open = 0;
  #sent = new Set<string>();

  constructor(source: FakeHistorySource, room: string, talk: FakeTalk = fakeTalk(), options: FakeRoomOptions = {}) {
    this.room = room;
    this.talk = talk;
    this.#source = source;
    const never = (agent: string, k: number) => options.neverProduced?.[agent]?.includes(k) ?? false;
    const capped = (agent: string, k: number) => options.capped?.[agent]?.includes(k) ?? false;
    const sliced = (
      agent: string,
      kind: EncodeOptions["kind"],
      lang: string,
      items: { atMs: number; item: Item }[],
      carryOf: (k: number) => Item[],
    ) => {
      const o: EncodeOptions = {
        agent: { name: agent, label: labelOf(agent), model: "fake" },
        lang,
        kind,
        costUsd: 0.01,
      };
      return {
        agent,
        track: ITEMS_TRACK,
        slice: (k: number) => {
          if (never(agent, k)) return [];
          const isCapped = capped(agent, k);
          const out = [{ atMs: sliceStart(k), payload: encodeCarry(o, k, carryOf(k), isCapped) }];
          if (isCapped) return out;
          const inSlice = items.filter(({ atMs }) => sliceOf(atMs) === k).sort((a, b) => a.atMs - b.atMs);
          for (const { atMs, item } of inSlice) out.push({ atMs, payload: encodeItem(o, k, item) });
          return out;
        },
      } satisfies AgentScript;
    };
    const linesWithInterim = talk.captions.flatMap((l) => [
      {
        atMs: l.startMs + 1_800,
        item: { ...l, endMs: l.startMs + 1_800, text: firstHalf(l.text), final: false } as Item,
      },
      { atMs: l.endMs + CAPTION_LATENCY_MS, item: l as Item },
    ]);
    const lastLines = (lines: LineItem[], producedAfter: number) => (k: number) =>
      lines.filter((l) => l.endMs + producedAfter < sliceStart(k)).slice(-2);
    const outlineOpts: EncodeOptions = {
      agent: { name: "chapters", label: labelOf("chapters"), model: "fake" },
      lang: "en",
      kind: "outline",
    };
    this.#scripts = [
      sliced("captions", "captions", "en", linesWithInterim, lastLines(talk.captions, CAPTION_LATENCY_MS)),
      sliced(
        "translate-tr",
        "translation",
        "tr",
        talk.translation.map((l) => ({ atMs: l.endMs + TRANSLATE_LATENCY_MS, item: l })),
        lastLines(talk.translation, TRANSLATE_LATENCY_MS),
      ),
      sliced(
        "describe",
        "slides",
        "en",
        talk.slides.map((s) => ({ atMs: s.atMs + DESCRIBE_LATENCY_MS, item: s })),
        (k) => talk.slides.filter((s) => s.atMs + DESCRIBE_LATENCY_MS < sliceStart(k)).slice(-1),
      ),
      {
        agent: "chapters",
        track: OUTLINE_TRACK,
        slice: () => [],
        snapshots: talk.outlines.map(({ atMs, outline }) => ({
          atMs,
          group: sliceOf(atMs),
          payload: encodeOutline(outlineOpts, sliceOf(atMs), outline),
        })),
      },
    ];
  }

  path(agent: string): string {
    return agentPath(this.room, agent);
  }

  /** Announce every agent and put the room at media time `ms`: history archived, the current slice live. */
  start(ms: number): void {
    this.#now = ms;
    const current = sliceOf(ms);
    for (const s of this.#scripts) {
      for (let k = 0; k < current; k++) {
        const objects = s.slice(k).map((o) => o.payload);
        if (objects.length > 0) this.#source.store(this.path(s.agent), s.track, k, objects);
      }
      for (const snap of s.snapshots ?? []) {
        if (snap.atMs > ms) continue;
        this.#source.store(this.path(s.agent), s.track, snap.group, [snap.payload]);
      }
    }
    for (const s of this.#scripts) this.#source.announce(this.path(s.agent));
    // The newest outline revision is the latest group a late joiner gets.
    for (const s of this.#scripts) {
      const latest = (s.snapshots ?? []).filter((x) => x.atMs <= ms).at(-1);
      if (latest) this.#publishOnce(s, latest.group, latest.payload, `snap:${latest.group}`);
    }
    this.#emitUpTo(ms, current);
  }

  /** Let media time run to `ms`, publishing live whatever the agents produce on the way. */
  advanceTo(ms: number): void {
    if (ms <= this.#now) return;
    this.#now = ms;
    this.#emitUpTo(ms, undefined);
  }

  get now(): number {
    return this.#now;
  }

  #emitUpTo(ms: number, from: number | undefined): void {
    // Items produced late can land one slice on; an older slice is closed.
    const first = from ?? this.#open;
    this.#open = Math.max(0, sliceOf(ms) - 1);
    for (const s of this.#scripts) {
      for (let k = first; k <= sliceOf(ms); k++) {
        s.slice(k).forEach((o, i) => {
          if (o.atMs <= ms) this.#publishOnce(s, k, o.payload, `${k}:${i}`);
        });
      }
      for (const snap of s.snapshots ?? [])
        if (snap.atMs <= ms) this.#publishOnce(s, snap.group, snap.payload, `snap:${snap.group}`);
    }
  }

  #publishOnce(s: AgentScript, group: number, payload: Uint8Array, id: string): void {
    const key = `${s.agent}#${id}`;
    if (this.#sent.has(key)) return;
    this.#sent.add(key);
    this.#source.publish(this.path(s.agent), s.track, group, payload);
  }
}

function firstHalf(text: string): string {
  const words = text.split(" ");
  return words.slice(0, Math.ceil(words.length / 2)).join(" ");
}

function labelOf(agent: string): string {
  if (agent === "captions") return "Captions (English)";
  if (agent === "translate-tr") return "Translation (Turkish)";
  if (agent === "describe") return "Slide descriptions";
  return "Chapters, glossary and recap";
}

// The offline /demo: a scripted room replayed through FakeTransport, so the viewer works with no
// relay. Captions grow word by word (interim text) and settle into lines, a Turkish and an Arabic
// translation follow each line, a slide gets described, the outline grows, and the caption agent is
// swapped for a new instance mid-talk, the way a restarted agent would be.

import { agentPath } from "../contracts/names";
import type { CaptionLine, Chapter, Envelope, GlossaryTerm, State } from "../contracts/types";
import type { FakeTransport } from "../transport/fake";

export type DemoEvent =
  | { at: number; type: "announce"; path: string }
  | { at: number; type: "withdraw"; path: string }
  | { at: number; type: "emit"; path: string; track: string; value: unknown };

interface Line {
  en: string;
  tr: string;
  ar: string;
}

const LINES: Line[] = [
  {
    en: "Welcome, everyone. Today we look at how rivers shape the land.",
    tr: "Herkese hoş geldiniz. Bugün nehirlerin araziyi nasıl şekillendirdiğine bakıyoruz.",
    ar: "مرحبًا بالجميع. نتناول اليوم كيف تشكّل الأنهار سطح الأرض.",
  },
  {
    en: "Water picks up small stones and carries them downstream.",
    tr: "Su küçük taşları alır ve akış yönünde taşır.",
    ar: "يلتقط الماء الحصى الصغيرة ويحملها مع التيار.",
  },
  {
    en: "Over thousands of years, this cuts deep valleys into rock.",
    tr: "Binlerce yıl içinde bu, kayalara derin vadiler oyar.",
    ar: "على مدى آلاف السنين، يحفر ذلك أودية عميقة في الصخر.",
  },
  {
    en: "On this slide you can see the Grand Canyon from above.",
    tr: "Bu slaytta Büyük Kanyon'u yukarıdan görebilirsiniz.",
    ar: "في هذه الشريحة يمكنكم رؤية الأخدود العظيم من الأعلى.",
  },
  {
    en: "Where the river slows down, it drops what it carried.",
    tr: "Nehrin yavaşladığı yerde taşıdıklarını bırakır.",
    ar: "حيث يتباطأ النهر، يُسقط ما كان يحمله.",
  },
  {
    en: "That is how deltas and fertile plains are built.",
    tr: "Deltalar ve verimli ovalar böyle oluşur.",
    ar: "هكذا تتكوّن الدلتاوات والسهول الخصبة.",
  },
];

const SLIDE_NOTE =
  "Aerial photograph of a deep, winding canyon in red and orange rock, with a thin river at the bottom. " +
  "Title at the top: Erosion over time.";

const WORD_MS = 280;
const LINE_GAP_MS = 900;
const TRANSLATE_DELAY_MS = 700;
const HEARTBEAT_MS = 2_000;
/** The caption agent is replaced by a new instance after this line. */
const SWAP_AFTER_LINE = 2;
const SWAP_GAP_MS = 1_500;

const AGENTS = {
  captions: { label: "Captions (English)", model: "Muse Voice Transcribe" },
  "translate-tr": { label: "Türkçe çeviri", model: "Muse Spark" },
  "translate-ar": { label: "الترجمة العربية", model: "Muse Spark" },
  describe: { label: "Slide descriptions", model: "Muse Spark vision" },
  chapters: { label: "Chapters, glossary and recap", model: "Muse Spark" },
} as const;

type AgentName = keyof typeof AGENTS;

/** Build the script's events, starting at time 0. `base` names the instances (start time in ms). */
export function demoEvents(room: string, base = 1_760_000_000_000): { events: DemoEvent[]; duration: number } {
  const events: DemoEvent[] = [];
  const seq = new Map<string, number>();
  const cost = new Map<string, number>();
  const instances: Record<AgentName, string> = {
    captions: String(base),
    "translate-tr": String(base + 40),
    "translate-ar": String(base + 70),
    describe: String(base + 110),
    chapters: String(base + 150),
  };
  const path = (agent: AgentName) => agentPath(room, agent, instances[agent]);

  const emit = (at: number, agent: AgentName, state: State, costDelta = 0) => {
    const p = path(agent);
    const s = (seq.get(p) ?? -1) + 1;
    seq.set(p, s);
    const c = (cost.get(p) ?? 0) + costDelta;
    cost.set(p, c);
    const envelope: Envelope = {
      v: 1,
      agent: { name: agent, ...AGENTS[agent] },
      instance: instances[agent],
      seq: s,
      at_ms: base + at,
      usage: { requests: Math.round(c * 10_000), input_tokens: 0, output_tokens: 0, cost_usd: round(c) },
      state,
    };
    events.push({ at, type: "emit", path: p, track: "state", value: envelope });
  };

  for (const agent of Object.keys(AGENTS) as AgentName[]) {
    events.push({ at: 0, type: "announce", path: path(agent) });
  }
  emit(50, "captions", { kind: "captions", lang: "en", lines: [], interim: "" });
  emit(60, "translate-tr", { kind: "translation", lang: "tr", lines: [] });
  emit(70, "translate-ar", { kind: "translation", lang: "ar", lines: [] });
  emit(80, "describe", { kind: "slides", lang: "en", slides: [] });
  emit(90, "chapters", { kind: "outline", lang: "en", chapters: [], glossary: [], recap: "" });

  const done: CaptionLine[] = [];
  const tr: { id: number; text: string }[] = [];
  const ar: { id: number; text: string }[] = [];
  const chapters: Chapter[] = [];
  const glossary: GlossaryTerm[] = [];
  let t = 600;

  LINES.forEach((line, id) => {
    const start = t;
    const words = line.en.split(" ");
    for (let w = 1; w < words.length; w++) {
      emit(
        t,
        "captions",
        { kind: "captions", lang: "en", lines: [...done], interim: words.slice(0, w).join(" ") },
        0.00002,
      );
      t += WORD_MS;
    }
    done.push({ id, start_ms: start, end_ms: t, text: line.en });
    emit(t, "captions", { kind: "captions", lang: "en", lines: [...done], interim: "" }, 0.00002);
    tr.push({ id, text: line.tr });
    ar.push({ id, text: line.ar });
    emit(t + TRANSLATE_DELAY_MS, "translate-tr", { kind: "translation", lang: "tr", lines: [...tr] }, 0.0004);
    emit(t + TRANSLATE_DELAY_MS + 150, "translate-ar", { kind: "translation", lang: "ar", lines: [...ar] }, 0.0004);

    if (id === 0) {
      chapters.push({
        id: 0,
        start_ms: start,
        title: "Rivers carry stone",
        summary: "How moving water picks up rock and wears the land down.",
      });
      emit(t + 1_200, "chapters", { kind: "outline", lang: "en", chapters: [...chapters], glossary: [] }, 0.001);
    }
    if (id === 2) {
      glossary.push({ term: "Erosion", definition: "The wearing away of rock and soil by water, wind or ice." });
      emit(
        t + 1_200,
        "chapters",
        { kind: "outline", lang: "en", chapters: [...chapters], glossary: [...glossary] },
        0.001,
      );
    }
    if (id === 3) {
      emit(
        start + 400,
        "describe",
        { kind: "slides", lang: "en", slides: [{ id: 0, at_ms: start, description: SLIDE_NOTE }] },
        0.003,
      );
    }
    if (id === 4) {
      chapters.push({
        id: 1,
        start_ms: start,
        title: "Deltas and plains",
        summary: "Where the river slows, it drops sediment and builds new land.",
      });
      glossary.push({ term: "Delta", definition: "Land built from sediment where a river meets the sea." });
      emit(
        t + 1_200,
        "chapters",
        { kind: "outline", lang: "en", chapters: [...chapters], glossary: [...glossary] },
        0.001,
      );
    }
    if (id === LINES.length - 1) {
      emit(
        t + 1_800,
        "chapters",
        {
          kind: "outline",
          lang: "en",
          chapters: [...chapters],
          glossary: [...glossary],
          recap: "Rivers wear rock away where they run fast and build land where they slow down.",
        },
        0.0015,
      );
    }

    if (id === SWAP_AFTER_LINE) {
      // The caption agent is replaced: the old instance is withdrawn, a new one announced. Line ids
      // are stable across the restart, so the new instance re-publishes every line so far.
      const old = path("captions");
      events.push({ at: t + 300, type: "withdraw", path: old });
      instances.captions = String(base + t + SWAP_GAP_MS);
      events.push({ at: t + SWAP_GAP_MS, type: "announce", path: path("captions") });
      emit(t + SWAP_GAP_MS + 100, "captions", { kind: "captions", lang: "en", lines: [...done], interim: "" });
      t += SWAP_GAP_MS + 200;
    }
    t += LINE_GAP_MS;
  });

  const duration = t + 4_000;
  addHeartbeats(events, duration);
  events.sort((a, b) => a.at - b.at);
  return { events, duration };
}

/** Every 2 s each live agent repeats its newest snapshot (same seq), as the real agents do. */
function addHeartbeats(events: DemoEvent[], until: number): void {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const live = new Map<string, { since: number; last?: unknown; end: number }>();
  for (const e of sorted) {
    if (e.type === "announce") live.set(e.path, { since: e.at, end: until });
    if (e.type === "withdraw") {
      const entry = live.get(e.path);
      if (entry) entry.end = e.at;
    }
  }
  for (const [path, entry] of live) {
    const emits = sorted.filter((e): e is Extract<DemoEvent, { type: "emit" }> => e.type === "emit" && e.path === path);
    for (let at = entry.since + HEARTBEAT_MS; at < entry.end; at += HEARTBEAT_MS) {
      const last = emits.filter((e) => e.at <= at).pop();
      if (last) events.push({ at, type: "emit", path, track: last.track, value: last.value });
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function applyEvent(transport: FakeTransport, event: DemoEvent): void {
  if (event.type === "announce") transport.announce(event.path);
  else if (event.type === "withdraw") transport.withdraw(event.path);
  else transport.emitJson(event.path, event.track, event.value);
}

/**
 * Play the script on a FakeTransport in real time, looping. Each loop withdraws what is left and
 * starts over with fresh instance numbers, the way restarted agents would come back.
 */
export function playDemo(transport: FakeTransport, room: string, options: { speed?: number } = {}): () => void {
  const speed = options.speed ?? 1;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  let loop = 0;

  const run = () => {
    if (stopped) return;
    const { events, duration } = demoEvents(room, Date.now() + loop * 1_000);
    loop += 1;
    for (const e of events) timers.push(setTimeout(() => applyEvent(transport, e), e.at / speed));
    timers.push(
      setTimeout(() => {
        for (const e of events) if (e.type === "announce") transport.withdraw(e.path);
        timers = [];
        run();
      }, duration / speed),
    );
  };
  run();
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}

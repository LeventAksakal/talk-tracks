import { describe, expect, it } from "vitest";
import { agentPath, ITEMS_TRACK, slidesPath } from "../contracts/names";
import { currentSlide, inkCarry, marksCarry } from "../contracts/tracks";
import type { RoomCatalog, ShowSlide } from "../contracts/types";
import type { TrackView } from "../playback/aiTracks";
import { FakeHistorySource } from "../playback/fakeSource";
import type { LineItem, Outline } from "../playback/wire";
import { DemoSlides } from "../player/demoSlides";
import { historyPath } from "../player/slideTracks";
import { buildLecturePackage } from "./build";
import { gatherableTranslations, whyFree } from "./languages";
import { gatherSlides } from "./slides";
import { readStoredZip, zipParts } from "./zip";

const ROOM = "r1";
/** Showing n of the demo starts at S(n), slide n mod 8 (demoSlides.ts). */
const S = (n: number) => 2_000 + 30_000 * n;

const line = (id: string, startMs: number, text: string): LineItem => ({
  type: "line",
  id,
  startMs,
  endMs: startMs + 3_000,
  text,
  final: true,
});

const OUTLINE: Outline = {
  chapters: [
    { id: 0, start_ms: 0, title: "Where rivers start", summary: "Springs and rain." },
    { id: 1, start_ms: 60_000, title: "Meanders", summary: "How bends grow." },
    { id: 2, start_ms: 120_000, title: "Deltas", summary: "Where rivers end." },
  ],
  glossary: [{ term: "Meander", definition: "A bend in a river." }],
  recap: "Rivers carve, carry and drop.",
};

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function unzip(blob: Blob): Promise<Map<string, Uint8Array>> {
  return readStoredZip(new Uint8Array(await blob.arrayBuffer()));
}
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe("the zip writer", () => {
  it("writes entries a reader gets back byte for byte, names in UTF-8", () => {
    const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const files = readStoredZip(
      join(
        zipParts([
          { path: "a.txt", data: "hello" },
          { path: "slides/01.png", data: png },
          { path: "transcript/tr.md", data: "Türkçe ağaç" },
        ]),
      ),
    );
    expect([...files.keys()]).toEqual(["a.txt", "slides/01.png", "transcript/tr.md"]);
    expect(text(files.get("a.txt"))).toBe("hello");
    expect([...files.get("slides/01.png")!]).toEqual([...png]);
    expect(text(files.get("transcript/tr.md"))).toBe("Türkçe ağaç");
  });
});

describe("the talk's slides, read by FETCH", () => {
  it("finds every slide shown and its ink and marks as they were when it was last on screen", async () => {
    const demo = new DemoSlides(ROOM, 600_000);
    demo.start(300_000);
    const to = 300_000;
    const got = await gatherSlides({ source: demo.source, room: ROOM, fromMs: 0, toMs: to });
    // The demo shows slide n mod 8 from S(n): ten showings by 300 s, all eight slides.
    expect(got.slides.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const third = got.slides[2]!;
    expect(third.shown.map((x) => x.fromMs)).toEqual([S(2)]);
    expect(third.image?.runs?.length).toBeGreaterThan(0);
    // The oracle: the speaker's whole script reduced up to the end of the slide's last span.
    for (const s of got.slides) {
      const end = s.shown.at(-1)!.toMs - 1;
      const show: ShowSlide = { kind: "show", deck: s.deck, index: s.index };
      const ink = inkCarry(
        demo.script.ink.filter((r) => r.m <= end),
        show,
      ).map((r) => r.data.stroke);
      const marks = marksCarry(
        demo.script.marks.filter((r) => r.m <= end),
        show,
      ).map((r) => r.data.id);
      expect(s.ink.map((e) => e.stroke)).toEqual(ink);
      expect(s.marks.map((k) => k.id)).toEqual(marks);
    }
    expect(got.slides.some((s) => s.ink.length > 0)).toBe(true);
    // And the slide on screen at the end is the one the script shows then.
    const last = currentSlide(demo.script.slide.filter((r) => r.m < to));
    expect(got.slides.find((s) => s.index === last?.index)?.shown.at(-1)?.toMs).toBe(to);
  });

  it("reads the listener's own ink and marks from the audience track, and nobody else's", async () => {
    // Showing 6 (slide 7) starts at S(6); the demo's listener Ada highlights at +15 s and ticks at +17 s.
    const demo = new DemoSlides(ROOM, 600_000);
    const to = S(6) + 20_000;
    demo.start(to);
    const ada = await gatherSlides({ source: demo.source, room: ROOM, fromMs: 0, toMs: to, mine: "u-ada" });
    const seventh = ada.slides.find((s) => s.index === 6)!;
    expect(seventh.mine.marks.map((k) => k.id)).toEqual(["u-ada-6m"]);
    expect(seventh.mine.ink.map((e) => e.stroke)).toEqual(["u-ada-6k"]);
    // The speaker cleared every earlier slide, Ada's annotations too, before moving on.
    for (const s of ada.slides) if (s.index !== 6) expect(s.mine).toEqual({ ink: [], marks: [] });
    // Someone else, or nobody asked: no annotations of the audience at all.
    const other = await gatherSlides({ source: demo.source, room: ROOM, fromMs: 0, toMs: to, mine: "u-bob" });
    const none = await gatherSlides({ source: demo.source, room: ROOM, fromMs: 0, toMs: to });
    for (const got of [other, none]) for (const s of got.slides) expect(s.mine).toEqual({ ink: [], marks: [] });
  });

  it("reads the newest slices on the live name when the archive does not have them yet", async () => {
    // Slide 5 goes up at S(4) = 122 s, in slice 30, the current one; the archive has not got it.
    const demo = new DemoSlides(ROOM, 600_000);
    demo.start(123_000);
    demo.source.drop(historyPath(slidesPath(ROOM)), "slide", 30);
    const got = await gatherSlides({ source: demo.source, room: ROOM, fromMs: 0, toMs: 123_000, fetchTimeoutMs: 200 });
    expect(got.slides.find((s) => s.index === 4)?.shown).toEqual([{ fromMs: S(4), toMs: 123_000 }]);
    expect(got.missingGroups).toBe(0);
  });

  it("stops when cancelled", async () => {
    const demo = new DemoSlides(ROOM, 600_000);
    demo.start(300_000);
    const controller = new AbortController();
    const run = gatherSlides({
      source: demo.source,
      room: ROOM,
      fromMs: 0,
      toMs: 300_000,
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done === 3) controller.abort();
      },
    });
    await expect(run).rejects.toBeDefined();
  });
});

describe("the lecture package", () => {
  it("is a zip whose manifest lists every file and whose lecture.md has every chapter, line and slide", async () => {
    const demo = new DemoSlides(ROOM, 600_000);
    demo.start(200_000);
    const en = {
      lang: "en",
      name: "English (original)",
      lines: [
        line("a", 1_000, "Rain falls on hills."),
        line("b", 65_000, "Bends grow outward."),
        line("c", 125_000, "Mud settles at the mouth."),
      ],
    };
    const es = { lang: "es", name: "Español", lines: [line("a", 1_000, "La lluvia cae.")] };
    const progress: number[] = [];
    const built = await buildLecturePackage({
      source: demo.source,
      room: ROOM,
      title: "How rivers shape the land",
      speaker: "Demo speaker",
      live: true,
      fromMs: 0,
      toMs: 200_000,
      talkMs: (ms) => ms,
      languages: [en, es],
      outline: OUTLINE,
      notes: [{ id: "n1", at: 66_000, slide: 3, text: "Ask about oxbow lakes" }],
      leftOut: ["العربية"],
      render: async ({ ink }) => new Uint8Array([137, 80, 78, 71, ink.length]),
      onProgress: (p) => progress.push(p.fraction),
    });
    expect(built.fileName).toBe("r1-lecture.zip");
    expect(progress.at(-1)).toBe(1);

    const files = await unzip(built.blob);
    const manifest = JSON.parse(text(files.get("manifest.json"))) as {
      format: string;
      version: number;
      entry: string;
      files: { path: string; bytes: number }[];
      languages: { lang: string; files: string[] }[];
      slides: { number: number; image: string | null; text: string }[];
      leftOut: { languages: string[] };
    };
    expect(manifest).toMatchObject({ format: "talk-tracks/lecture-package", version: 1, entry: "lecture.md" });
    // Every file in the zip is in the manifest, with its size, and nothing else.
    const listed = manifest.files.map((f) => f.path).sort();
    expect(listed).toEqual([...files.keys()].filter((p) => p !== "manifest.json").sort());
    for (const f of manifest.files) expect(files.get(f.path)!.length).toBe(f.bytes);
    for (const p of ["README.md", "lecture.md", "chapters.json", "glossary.json", "notes.md"])
      expect(files.has(p)).toBe(true);
    expect(manifest.languages.map((l) => l.lang)).toEqual(["en", "es"]);
    for (const p of ["transcript/en.vtt", "transcript/en.md", "transcript/es.vtt", "transcript/es.md"])
      expect(files.has(p)).toBe(true);
    expect(text(files.get("transcript/es.vtt"))).toContain("La lluvia cae.");
    expect(manifest.leftOut.languages).toEqual(["العربية"]);
    // Every slide of the deck has its picture and text.
    expect(manifest.slides.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const s of manifest.slides) {
      expect(files.has(s.image!)).toBe(true);
      expect(files.has(s.text)).toBe(true);
    }
    expect(JSON.parse(text(files.get("chapters.json"))).chapters).toHaveLength(3);
    expect(JSON.parse(text(files.get("glossary.json")))).toEqual(OUTLINE.glossary);
    expect(text(files.get("notes.md"))).toContain("Ask about oxbow lakes");

    const lecture = text(files.get("lecture.md"));
    for (const [i, c] of OUTLINE.chapters.entries()) expect(lecture).toContain(`## ${i + 1}. ${c.title}`);
    // Each line sits under its chapter, in order; a slide's text appears where it was first shown.
    const at = (s: string) => lecture.indexOf(s);
    expect(at("Rain falls on hills.")).toBeGreaterThan(at("## 1. Where rivers start"));
    expect(at("Bends grow outward.")).toBeGreaterThan(at("## 2. Meanders"));
    expect(at("Bends grow outward.")).toBeLessThan(at("## 3. Deltas"));
    expect(at("Mud settles at the mouth.")).toBeGreaterThan(at("## 3. Deltas"));
    expect(at("**Slide 3**")).toBeGreaterThan(at("## 2. Meanders"));
    const slideThree = text(files.get("slides/03.md")).split("\n").slice(-2)[0]!;
    expect(lecture).toContain(slideThree);
    expect(lecture).toContain("Ask about oxbow lakes");
  });

  it("adds a second picture of each slide the listener annotated, and the slide descriptions when given", async () => {
    const demo = new DemoSlides(ROOM, 600_000);
    const to = S(6) + 20_000;
    demo.start(to);
    const input = {
      source: demo.source,
      room: ROOM,
      title: "How rivers shape the land",
      speaker: undefined,
      live: true,
      fromMs: 0,
      toMs: to,
      talkMs: (ms: number) => ms,
      languages: [],
      outline: undefined,
      notes: [],
      leftOut: [],
      render: async ({ ink, marks }: { ink: readonly unknown[]; marks: readonly unknown[] }) =>
        new Uint8Array([137, 80, 78, 71, ink.length, marks.length]),
    };
    const built = await buildLecturePackage({
      ...input,
      mine: "u-ada",
      descriptions: [
        { type: "slide", id: 2, atMs: S(2) + 3_000, description: "A river bends through a valley." },
        { type: "slide", id: 6, atMs: S(6) + 2_000, description: "A delta fans into the sea." },
      ],
    });
    const files = await unzip(built.blob);
    type Slide = { number: number; image: string; mine: { image: string; ink: number; marks: number } | null };
    const manifest = JSON.parse(text(files.get("manifest.json"))) as {
      version: number;
      descriptions: number | null;
      slides: (Slide & { description?: string | null })[];
      files: { path: string; role: string }[];
    };
    // Only slide 7 still carries Ada's highlight and tick: its second picture has them over the speaker's.
    expect([...files.keys()].filter((p) => p.endsWith(".mine.png"))).toEqual(["slides/07.mine.png"]);
    const seventh = manifest.slides.find((s) => s.number === 7)!;
    expect(seventh.mine).toEqual({ image: "slides/07.mine.png", ink: 1, marks: 1 });
    // The fake renderer writes the counts of ink and marks it drew as the last two bytes.
    const drawn = (p: string) => [...files.get(p)!.slice(-2)];
    const [ink, marks] = drawn("slides/07.png");
    expect(drawn("slides/07.mine.png")).toEqual([ink! + 1, marks! + 1]);
    expect(manifest.slides.filter((s) => s.mine)).toHaveLength(1);
    expect(manifest.files.find((f) => f.path === "slides/07.mine.png")?.role).toBe("slide-image-mine");
    // The descriptions sit with their slides.
    expect(manifest.descriptions).toBe(2);
    expect(manifest.slides.find((s) => s.number === 3)?.description).toBe("A river bends through a valley.");
    expect(text(files.get("slides/07.md"))).toContain("A delta fans into the sea.");
    expect(text(files.get("lecture.md"))).toContain("A delta fans into the sea.");
    expect(text(files.get("README.md"))).toContain("slides/NN.mine.png");

    // Without descriptions (the describe agent was not running) the manifest says so, and nothing else changes.
    const plain = await unzip((await buildLecturePackage({ ...input, mine: "u-ada" })).blob);
    const bare = JSON.parse(text(plain.get("manifest.json"))) as typeof manifest;
    expect(bare.descriptions).toBeNull();
    expect(bare.slides.every((s) => !("description" in s))).toBe(true);
    expect(text(plain.get("README.md"))).not.toContain("Slide descriptions");
  });

  it("still makes a package for a room with no slides or captions", async () => {
    const built = await buildLecturePackage({
      source: new FakeHistorySource(),
      room: ROOM,
      title: "Quiet room",
      speaker: undefined,
      live: false,
      fromMs: 0,
      toMs: 8_000,
      talkMs: (ms) => ms,
      languages: [],
      outline: undefined,
      notes: [],
      leftOut: [],
      fetchTimeoutMs: 50,
    });
    const files = await unzip(built.blob);
    expect([...files.keys()]).toContain("lecture.md");
    expect(JSON.parse(text(files.get("manifest.json"))).slides).toEqual([]);
  });
});

describe("the cost guard", () => {
  const view = (agent: string, enabled = false): TrackView =>
    ({
      id: `${agent}/items`,
      agent,
      track: ITEMS_TRACK,
      kind: "translation",
      lang: agent.slice(10),
      enabled,
    }) as TrackView;
  const now = 1_000_000;
  const catalog = (cost: "paid" | "free", status: Record<string, "idle" | "live">): RoomCatalog => ({
    tracks: ["translate-es", "translate-tr", "translate-ar"].map((a) => ({
      name: ITEMS_TRACK,
      namespace: agentPath(ROOM, a),
      packaging: "eventtimeline",
      tt: { cost },
    })),
    tt: {
      E: 0,
      shift: {},
      status: Object.fromEntries(
        Object.entries(status).map(([a, s]) => [
          a,
          { status: s, producing: s === "live", fetches_served: 0, backfills: 0, spend_usd: 0, updated_ms: now },
        ]),
      ),
    },
  });
  const tracks = [view("translate-es"), view("translate-tr", true), view("translate-ar")];

  it("reads the slide descriptions only while the describe agent runs or was recorded", () => {
    const describe = { ...view("describe"), kind: "slides", lang: "en" } as TrackView;
    const guard = (cost: "paid" | "free", status: Record<string, "idle" | "live">) => {
      const c = catalog(cost, status);
      c.tracks.push({
        name: ITEMS_TRACK,
        namespace: agentPath(ROOM, "describe"),
        packaging: "eventtimeline",
        tt: { cost },
      });
      return { catalog: c, room: ROOM, offline: false, now };
    };
    expect(whyFree(describe, guard("paid", { describe: "idle" }))).toBeUndefined();
    expect(whyFree(describe, guard("paid", { describe: "live" }))).toBe("running");
    expect(whyFree(describe, guard("free", {}))).toBe("free");
  });

  it("gathers only translations that are subscribed, running or recorded, never one that would wake an agent", () => {
    const live = gatherableTranslations(tracks, {
      catalog: catalog("paid", { "translate-es": "live", "translate-ar": "idle" }),
      room: ROOM,
      offline: false,
      now,
    });
    expect(live.included.map((t) => t.lang)).toEqual(["es", "tr"]);
    expect(live.left.map((t) => t.lang)).toEqual(["ar"]);
    // A looped room's recorded tracks are free; with no catalog yet, only what is subscribed.
    expect(
      gatherableTranslations(tracks, { catalog: catalog("free", {}), room: ROOM, offline: false, now }).left,
    ).toEqual([]);
    expect(
      gatherableTranslations(tracks, { catalog: undefined, room: ROOM, offline: false, now }).included.map(
        (t) => t.lang,
      ),
    ).toEqual(["tr"]);
    // A running agent whose status went stale is idle.
    expect(
      gatherableTranslations(tracks, {
        catalog: catalog("paid", { "translate-es": "live" }),
        room: ROOM,
        offline: false,
        now: now + 60_000,
      }).included.map((t) => t.lang),
    ).toEqual(["tr"]);
  });
});

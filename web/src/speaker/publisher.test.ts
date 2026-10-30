import { describe, expect, it } from "vitest";
import { DECK_TRACK, FRAMES_TRACK, INK_TRACK, MARKS_TRACK, POINTER_TRACK, SLIDE_TRACK } from "../contracts/names";
import { currentSlide, inkCarry, lastRecord, marksCarry } from "../contracts/tracks";
import type {
  CurrentSlideRecord,
  DeckImage,
  InkRecord,
  MarkRecord,
  PointerRecord,
  TextRun,
} from "../contracts/types";
import {
  parseCurrentSlideObject,
  parseDeckObject,
  parseInkObject,
  parseMarksObject,
  parsePointerObject,
  parseSlideFrame,
} from "../contracts/validate";
import { SlidesPublisher } from "./publisher";
import { MemoryBroadcast } from "./sink";

const SPEAKER = { id: "speaker", name: "Ada", speaker: true };
const PEN = { tool: "pen" as const, color: "#e5383b", width: 0.004 };
const runs: TextRun[] = [
  { id: "t0", text: "Hello world", box: { x: 0.1, y: 0.1, w: 0.5, h: 0.08 } },
  { id: "t1", text: "Second line", box: { x: 0.1, y: 0.2, w: 0.4, h: 0.08 } },
];
const image = (index: number): DeckImage => ({
  kind: "image",
  index,
  mime: "image/webp",
  width: 1600,
  height: 900,
  data_b64: "UklGRg==",
  runs,
});

function setup(start = 10_000) {
  const sink = new MemoryBroadcast();
  const clock = { t: start };
  const pub = new SlidesPublisher(sink, SPEAKER, "test");
  const deck = () => {
    pub.loadDeck({ kind: "deck", count: 3, aspect: 16 / 9, title: "Viruses" });
    for (let i = 0; i < 3; i++) pub.addImage(image(i));
  };
  return { sink, clock, pub, deck, live: () => pub.goLive(() => clock.t) };
}

const PARSERS = {
  [DECK_TRACK]: parseDeckObject,
  [SLIDE_TRACK]: parseCurrentSlideObject,
  [INK_TRACK]: parseInkObject,
  [MARKS_TRACK]: parseMarksObject,
  [POINTER_TRACK]: parsePointerObject,
} as const;

/** Every object written, checked against the contract's schema for its track. */
function expectAllValid(sink: MemoryBroadcast) {
  for (const o of sink.written) {
    if (o.track === FRAMES_TRACK) {
      expect(parseSlideFrame(o.payload).ok, `${o.track} ${o.group}/${o.object}`).toBe(true);
      continue;
    }
    const parse = PARSERS[o.track as keyof typeof PARSERS];
    const parsed = parse(o.payload);
    expect(parsed.ok ? "ok" : parsed.error, `${o.track} ${o.group}/${o.object}`).toBe("ok");
  }
}

const records = <R>(sink: MemoryBroadcast, track: string, group: number) =>
  (sink.objects(track, group) as R[][]).flat();

describe("the speaker's slide broadcast", () => {
  it("publishes nothing before the room clock, then the deck, slide and ink drawn meanwhile", () => {
    const { sink, clock, pub, deck, live } = setup();
    deck();
    pub.show(0);
    const s = pub.beginStroke(PEN, [0.2, 0.2])!;
    pub.addPoints(s, [[0.3, 0.3]]);
    pub.endStroke(s);
    expect(sink.written).toHaveLength(0);

    clock.t = 10_500;
    live();
    // The deck's id is the slice it went out in, and every record names it.
    expect(pub.deckId).toBe(2);
    const deckObjects = sink.objects(DECK_TRACK, 2) as { data: { kind: string } }[][];
    expect(deckObjects.map((o) => o[0]!.data.kind)).toEqual(["deck", "image", "image", "image"]);
    expect(records<CurrentSlideRecord>(sink, SLIDE_TRACK, 2)).toEqual([
      { m: 10_500, data: { kind: "show", deck: 2, index: 0 } },
    ]);
    const ink = records<InkRecord>(sink, INK_TRACK, 2);
    expect(ink).toHaveLength(1);
    expect(ink[0]!.data).toMatchObject({ kind: "stroke", stroke: s, deck: 2, index: 0, done: true });
    expect(ink[0]!.data.kind === "stroke" && ink[0]!.data.points).toEqual([
      [0.2, 0.2],
      [0.3, 0.3],
    ]);
    expectAllValid(sink);
  });

  it("draws a stroke as begin, points and end in the slice of its time, carried whole into the next", () => {
    const { sink, clock, pub, deck, live } = setup();
    live();
    deck();
    pub.show(0);
    clock.t = 13_000;
    const s = pub.beginStroke(PEN, [0.1, 0.1])!;
    clock.t = 13_050;
    pub.addPoints(s, [
      [0.15, 0.12],
      [0.2, 0.14],
    ]);
    clock.t = 13_100;
    pub.endStroke(s);
    const kinds = (sink.objects(INK_TRACK, 3) as InkRecord[][]).map((o) => o.map((r) => r.data.kind));
    expect(kinds).toEqual([[], ["begin"], ["points"], ["end"]]);

    clock.t = 16_001;
    pub.tick();
    const carry = records<InkRecord>(sink, INK_TRACK, 4);
    expect(carry).toHaveLength(1);
    expect(carry[0]).toMatchObject({ m: 13_000, data: { kind: "stroke", stroke: s, done: true } });
    expectAllValid(sink);
  });

  it("opens every slice with its carry-in while live, even when nothing happens", () => {
    const { sink, clock, pub, deck, live } = setup();
    live();
    deck();
    pub.show(1);
    pub.pointerAt(0.5, 0.5);
    for (const t of [12_000, 16_000, 20_000]) {
      clock.t = t;
      pub.tick();
    }
    for (const track of [SLIDE_TRACK, INK_TRACK, MARKS_TRACK, POINTER_TRACK]) {
      expect(sink.groups(track)).toEqual([2, 3, 4, 5]);
    }
    expect(records<CurrentSlideRecord>(sink, SLIDE_TRACK, 5)).toEqual([
      { m: 10_000, data: { kind: "show", deck: 2, index: 1 } },
    ]);
    expect(records<PointerRecord>(sink, POINTER_TRACK, 5)).toEqual([{ m: 10_000, data: { kind: "at", x: 0.5, y: 0.5 } }]);
    // Each slice is closed (End of Group) when the next opens.
    expect(sink.closedGroups.has(`${INK_TRACK}#4`)).toBe(true);
    expect(sink.closedGroups.has(`${INK_TRACK}#5`)).toBe(false);
  });

  it("re-sends a slide's strokes and marks when it is shown again, never the laser", () => {
    const { sink, clock, pub, deck, live } = setup();
    live();
    deck();
    pub.show(0);
    const s = pub.beginStroke({ tool: "highlighter", color: "#ffd400", width: 0.02 }, [0.4, 0.4])!;
    pub.endStroke(s);
    const k = pub.mark("underline", "#e5383b", [{ run: "t0", start: 0, end: 5 }])!;
    pub.pointerAt(0.6, 0.6);
    clock.t = 10_200;
    pub.show(1);
    expect(pub.state().strokes).toEqual([]);
    clock.t = 10_400;
    pub.show(0);

    const ink = records<InkRecord>(sink, INK_TRACK, 2);
    expect(ink.at(-1)).toMatchObject({ m: 10_400, data: { kind: "stroke", stroke: s, tool: "highlighter" } });
    const marks = records<MarkRecord>(sink, MARKS_TRACK, 2);
    expect(marks.at(-1)).toMatchObject({ m: 10_400, data: { kind: "mark", id: k, style: "underline" } });
    const pointer = records<PointerRecord>(sink, POINTER_TRACK, 2);
    expect(pointer).toHaveLength(1);
    expect(pub.state().strokes.map((r) => r.data.stroke)).toEqual([s]);
    expectAllValid(sink);
  });

  it("publishes the laser as samples and off, carried as its last record", () => {
    const { sink, clock, pub, deck, live } = setup();
    live();
    deck();
    pub.show(0);
    pub.pointerAt(0.1, 0.2);
    clock.t = 10_050;
    pub.pointerAt(0.12, 0.22);
    clock.t = 10_100;
    pub.pointerOff();
    pub.pointerOff();
    const kinds = records<PointerRecord>(sink, POINTER_TRACK, 2).map((r) => r.data.kind);
    expect(kinds).toEqual(["at", "at", "off"]);
    clock.t = 12_000;
    pub.tick();
    expect(records<PointerRecord>(sink, POINTER_TRACK, 3)).toEqual([{ m: 10_100, data: { kind: "off" } }]);
    expectAllValid(sink);
  });

  it("erases strokes and marks, and clears the slide, as the speaker", () => {
    const { sink, clock, pub, deck, live } = setup();
    live();
    deck();
    pub.show(0);
    const a = pub.beginStroke(PEN, [0.1, 0.1])!;
    pub.endStroke(a);
    const b = pub.beginStroke(PEN, [0.5, 0.5])!;
    pub.endStroke(b);
    const k = pub.mark("highlight", "#ffd400", [{ run: "t1" }])!;
    pub.erase([a], [k]);
    expect(pub.state().strokes.map((r) => r.data.stroke)).toEqual([b]);
    expect(pub.state().marks).toEqual([]);
    pub.mark("underline", "#1e6bd6", [{ run: "t0" }]);
    pub.clearSlide();
    expect(pub.state()).toMatchObject({ strokes: [], marks: [] });

    const ink = records<InkRecord>(sink, INK_TRACK, 2).map((r) => r.data);
    expect(ink.filter((d) => d.kind === "erase")).toEqual([{ kind: "erase", strokes: [a], by: SPEAKER }]);
    expect(ink.at(-1)).toEqual({ kind: "clear", deck: 2, index: 0, by: SPEAKER });
    const marks = records<MarkRecord>(sink, MARKS_TRACK, 2).map((r) => r.data.kind);
    expect(marks).toEqual(["mark", "unmark", "mark", "clear"]);
    clock.t = 12_000;
    pub.tick();
    expect(sink.objects(INK_TRACK, 3)).toEqual([[]]);
    expect(sink.objects(MARKS_TRACK, 3)).toEqual([[]]);
    expectAllValid(sink);
  });

  it("keeps the container rule: a slice's carry-in plus its deltas is the next slice's carry-in", () => {
    const { sink, clock, pub, deck, live } = setup();
    live();
    deck();
    let t = 10_000;
    const step = () => (clock.t = t += 137);
    pub.show(0);
    for (let i = 0; i < 40; i++) {
      step();
      if (i % 9 === 3) pub.show((i / 9) % 3 | 0);
      const s = pub.beginStroke(PEN, [0.1 + i / 100, 0.2])!;
      step();
      pub.addPoints(s, [[0.2 + i / 100, 0.3]]);
      step();
      pub.endStroke(s);
      if (i % 5 === 0) pub.mark("underline", "#e5383b", [{ run: "t0", start: 0, end: 3 }]);
      if (i % 7 === 6) pub.erase([s], []);
      if (i === 25) pub.clearSlide();
      if (i % 4 === 0) pub.pointerAt(0.5, i / 40);
      if (i % 4 === 2) pub.pointerOff();
    }
    clock.t = t + 4_000;
    pub.tick();
    const groups = sink.groups(INK_TRACK);
    expect(groups.length).toBeGreaterThan(3);
    for (const k of groups.slice(0, -1)) {
      const slide = records<CurrentSlideRecord>(sink, SLIDE_TRACK, k);
      const on = currentSlide(slide);
      const next = (track: string) => sink.objects(track, k + 1)[0];
      expect(next(INK_TRACK)).toEqual(inkCarry(records<InkRecord>(sink, INK_TRACK, k), on));
      expect(next(MARKS_TRACK)).toEqual(marksCarry(records<MarkRecord>(sink, MARKS_TRACK, k), on));
      expect(next(SLIDE_TRACK)).toEqual(lastRecord(slide));
      expect(next(POINTER_TRACK)).toEqual(lastRecord(records(sink, POINTER_TRACK, k)));
      // Every record sits in the slice of its m, except a carry-in's, which keeps when it took effect.
      for (const track of [SLIDE_TRACK, INK_TRACK, MARKS_TRACK, POINTER_TRACK]) {
        const deltas = (sink.objects(track, k) as { m: number }[][]).slice(1).flat();
        for (const r of deltas) expect(Math.floor(r.m / 4000)).toBe(k);
      }
    }
    expectAllValid(sink);
  });

  it("gives each new deck its own group, after the previous one", () => {
    const { sink, pub, deck, live } = setup();
    live();
    deck();
    expect(pub.deckId).toBe(2);
    deck();
    expect(pub.deckId).toBe(3);
    expect(sink.groups(DECK_TRACK)).toEqual([2, 3]);
    expect(sink.closedGroups.has(`${DECK_TRACK}#2`)).toBe(true);
    expectAllValid(sink);
  });

  it("sends a picture of each slide shown for the describe agent", () => {
    const { sink, pub, deck, live } = setup();
    live();
    deck();
    pub.show(0);
    pub.publishFrame({ at_ms: 1_793_000_000_000, mime: "image/jpeg", data_b64: "/9j/4A==" });
    pub.publishFrame({ at_ms: 1_793_000_000_100, mime: "image/jpeg", data_b64: "/9j/4A==" });
    expect(sink.groups(FRAMES_TRACK)).toEqual([2, 3]);
    expectAllValid(sink);
  });

  it("closes every group and the broadcast when the talk ends", () => {
    const { sink, pub, deck, live } = setup();
    live();
    deck();
    pub.show(0);
    pub.stop();
    expect(sink.closed).toBe(true);
    for (const track of [SLIDE_TRACK, INK_TRACK, MARKS_TRACK, POINTER_TRACK]) {
      expect(sink.closedGroups.has(`${track}#2`)).toBe(true);
    }
    expect(sink.closedGroups.has(`${DECK_TRACK}#2`)).toBe(true);
  });
});

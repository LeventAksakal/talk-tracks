import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogPath, ROOM_TRACK, slidesPath } from "../contracts/names";
import type { InkElement, InkStroke, Point, RoomStateRecord, TextRun } from "../contracts/types";
import { FakeHistorySource } from "../playback/fakeSource";
import { DEFAULT_PREFS } from "./prefs";
import { DemoSlides } from "./demoSlides";
import { drawInk, markBoxes } from "./overlays";
import { historyPath, SlideTracks } from "./slideTracks";
import { playerState } from "./state";
import { wantedSlideTracks } from "./tracks";

const ROOM = "r1";
const ALL = wantedSlideTracks(true, DEFAULT_PREFS);
/** Showing n of the demo starts at S(n); slide index n mod 8. */
const S = (n: number) => 2_000 + 30_000 * n;

function asStroke(e: InkElement): InkStroke {
  if (e.kind !== "stroke") throw new Error(`${e.stroke} is a ${e.kind}`);
  return e;
}

let open: SlideTracks[] = [];
afterEach(() => {
  open.forEach((s) => s.close());
  open = [];
});

function demoRoom(startMs: number) {
  const demo = new DemoSlides(ROOM, 600_000);
  demo.start(startMs);
  const slides = new SlideTracks(demo.source, ROOM, { catalog: () => demo.catalog });
  open.push(slides);
  return { demo, slides, source: demo.source };
}

/** Rewound to t: the store fetches what the playhead needs; wait until it has drawn something there. */
async function seek(slides: SlideTracks, t: number, edge: number) {
  slides.setTime(t, "rewound", edge);
  await vi.waitFor(() => expect(slides.slideAt(t)?.slide).toBeTruthy());
}

describe("slides, ink, marks and laser at a time t", () => {
  it("rebuilds the state after a seek from the one group at t: object 0 plus its deltas up to t", async () => {
    const { slides, source } = demoRoom(300_000);
    slides.setWanted(ALL);
    // Showing 2 (slide 3): the pen ring was erased at S+22 s; at S+23 s the highlighter stroke, the listener's tick
    // and all three marks are on, none of them made in this slice.
    const t = S(2) + 23_000;
    await seek(slides, t, 300_000);
    await vi.waitFor(() => expect(slides.inkAt(t)?.length).toBe(2));
    expect(slides.slideAt(t)?.slide).toMatchObject({ deck: 0, index: 2 });
    expect(slides.inkAt(t)?.map((s) => s.data.stroke)).toEqual(["u-ada-2k", "sp2b"]);
    expect(
      slides
        .slideAt(t)
        ?.marks.map((k) => k.data.id)
        .sort(),
    ).toEqual(["sp2m1", "sp2m2", "u-ada-2m"]);
    // One group per track, the one at t: nothing earlier was read.
    const archive = historyPath(slidesPath(ROOM));
    const k = Math.floor(t / 4_000);
    expect(source.fetchedGroups(archive, "ink")).toEqual([k]);
    expect(source.fetchedGroups(archive, "slide")).toEqual([k]);
  });

  it("shows a stroke growing as its points arrive, then gone when erased", async () => {
    const { slides } = demoRoom(300_000);
    slides.setWanted(ALL);
    const begun = S(2) + 5_000;
    await seek(slides, begun + 100, 300_000);
    await vi.waitFor(() => expect(slides.inkAt(begun + 100)).toHaveLength(1));
    const early = asStroke(slides.inkAt(begun + 100)![0]!.data);
    const later = asStroke(slides.inkAt(begun + 700)![0]!.data);
    expect(early.stroke).toBe("sp2a");
    expect(early.done).toBe(false);
    expect(later.points.length).toBeGreaterThan(early.points.length);
    await vi.waitFor(() => expect(slides.inkAt(begun + 1_400)?.[0]?.data).toMatchObject({ done: true }));

    const erased = S(2) + 22_100;
    await seek(slides, erased, 300_000);
    await vi.waitFor(() => expect(slides.inkAt(erased)?.map((s) => s.data.stroke)).not.toContain("sp2a"));
  });

  it("draws shapes and applies undo and redo after a seek, as the room saw them", async () => {
    const { slides } = demoRoom(300_000);
    slides.setWanted(ALL);
    const ids = (t: number) => slides.inkAt(t)?.map((e) => e.data.stroke);
    // Showing 2: a rectangle dragged out at S+23.2 s, an arrow at S+24.2 s, undone at S+25.2 s, redone at S+25.8 s.
    const dragging = S(2) + 23_300;
    await seek(slides, dragging, 300_000);
    await vi.waitFor(() => expect(ids(dragging)).toContain("sp2r"));
    const early = slides.inkAt(dragging)!.find((e) => e.data.stroke === "sp2r")!.data;
    const done = slides.inkAt(S(2) + 23_800)!.find((e) => e.data.stroke === "sp2r")!.data;
    expect(early.kind === "shape" && done.kind === "shape" && done.end[0] > early.end[0]).toBe(true);

    expect(ids(S(2) + 25_000)).toContain("sp2w");
    expect(ids(S(2) + 25_500)).not.toContain("sp2w");
    expect(ids(S(2) + 25_900)).toContain("sp2w");
    // A late joiner at the next slice reads its object 0 alone: both shapes, the arrow where it was redone.
    const late = S(2) + 26_500;
    await seek(slides, late, 300_000);
    await vi.waitFor(() => expect(ids(late)).toEqual(expect.arrayContaining(["sp2r", "sp2w"])));
  });

  it("moves the laser while it is held and hides it after off", async () => {
    const { slides } = demoRoom(300_000);
    slides.setWanted(ALL);
    const t = S(1) + 2_300; // mid-sweep along the title
    await seek(slides, t, 300_000);
    await vi.waitFor(() => expect(slides.pointerAt(t)).not.toBeNull());
    const a = slides.pointerAt(t)!;
    const b = slides.pointerAt(t + 400)!;
    expect(b.x).toBeGreaterThan(a.x);
    expect(slides.pointerAt(S(1) + 3_500)).toBeNull();
  });

  it("live, draws what arrives on the subscription, point by point, with no FETCH", async () => {
    const begun = S(2) + 5_000;
    const { demo, slides, source } = demoRoom(begun + 50);
    slides.setWanted(ALL);
    slides.setTime(begun + 50, "live", begun + 50);
    await vi.waitFor(() => expect(slides.inkAt(begun + 50)).toHaveLength(1));
    const first = asStroke(slides.inkAt(begun + 50)![0]!.data).points.length;
    demo.advanceTo(begun + 600);
    await vi.waitFor(() => expect(asStroke(slides.inkAt(begun + 600)![0]!.data).points.length).toBeGreaterThan(first));
    expect(slides.slideAt(begun + 600)?.slide?.index).toBe(2);
    expect(source.fetches.filter((f) => f.track !== "deck")).toEqual([]);
  });

  it("subscribes nothing of the slides until they are on screen, and the audience's only when wanted", () => {
    const { slides, source } = demoRoom(60_000);
    const subscribed = () => source.subscriptions.map((s) => `${s.path.split("/").slice(2).join("/")}/${s.track}`);
    slides.setWanted(wantedSlideTracks(false, DEFAULT_PREFS));
    expect(subscribed()).toEqual(["catalog/room"]);
    slides.setWanted(wantedSlideTracks(true, { annotations: "speaker" }));
    expect(subscribed()).not.toContain("annotations/ink");
    expect(subscribed()).toContain("slides/ink");
    slides.setWanted(wantedSlideTracks(false, DEFAULT_PREFS));
    expect(source.subscriberCount(slidesPath(ROOM), "ink")).toBe(0);
  });

  it("shows the slide a hovered time had, fetched once the pointer rests, with its picture", async () => {
    const { slides, source } = demoRoom(300_000);
    slides.setWanted(ALL);
    slides.setTime(299_000, "live", 300_000);
    const hover = S(3) + 1_000;
    expect(slides.previewAt(hover)).toBeUndefined();
    await vi.waitFor(() => expect(slides.previewAt(hover)).toMatchObject({ index: 3 }));
    expect(source.fetchedGroups(historyPath(slidesPath(ROOM)), "slide")).toContain(Math.floor(hover / 4_000));
    await vi.waitFor(() => expect(slides.picture(0, 3)?.url).toBeTruthy());
  });
});

describe("the room's state", () => {
  const state = (m: number, s: RoomStateRecord["data"]["state"]) => [{ m, data: { kind: "state", state: s } }];
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it("reads a stretch nobody published as paused, and the newest group as the state now", async () => {
    const source = new FakeHistorySource();
    const path = catalogPath(ROOM);
    source.announce(path);
    for (const k of [0, 1, 3]) source.store(path, ROOM_TRACK, k, [json(state(0, "on_air"))]);
    const slides = new SlideTracks(source, ROOM, { catalog: () => undefined });
    open.push(slides);
    slides.setWanted(["room"]);

    slides.setTime(5_000, "rewound", 20_000);
    await vi.waitFor(() => expect(slides.roomAt(5_000)).toBe("on_air"));
    slides.setTime(9_000, "rewound", 20_000);
    await vi.waitFor(() => expect(slides.roomAt(9_000)).toBe("paused"));

    source.publish(path, ROOM_TRACK, 4, json([...state(0, "on_air"), ...state(16_500, "ended")]));
    await vi.waitFor(() => expect(slides.roomNow()).toBe("ended"));
  });

  it("tells the talk's title and speaker from the room track, the newest that says them", async () => {
    const source = new FakeHistorySource();
    const path = catalogPath(ROOM);
    source.announce(path);
    const slides = new SlideTracks(source, ROOM, { catalog: () => undefined });
    open.push(slides);
    slides.setWanted(["room"]);
    expect(slides.roomInfo()).toEqual({ title: undefined, speaker: undefined });
    const said = { kind: "state", state: "on_air", title: "Quantum 101", speaker: "Ada" };
    source.publish(
      path,
      ROOM_TRACK,
      0,
      json([
        { m: 0, data: said },
        { m: 9_000, data: { kind: "state", state: "paused" } },
      ]),
    );
    await vi.waitFor(() => expect(slides.roomInfo()).toEqual({ title: "Quantum 101", speaker: "Ada" }));
  });

  it("decides paused, ended and not started over the media's own guess", () => {
    const base = { connection: "connected", everConnected: true, mode: "live", liveEdge: 60_000, behindMs: 0 } as const;
    expect(playerState({ ...base, onAir: false, room: "on_air" }).kind).toBe("live");
    expect(playerState({ ...base, onAir: true, room: "ended" }).kind).toBe("ended");
    expect(playerState({ ...base, onAir: true, room: "waiting" }).kind).toBe("not-started");
    const back = playerState({
      ...base,
      mode: "rewound",
      behindMs: 30_000,
      onAir: true,
      room: "on_air",
      roomAt: "paused",
    });
    expect([back.kind, back.canGoLive, back.card?.dim]).toEqual(["behind", true, true]);
  });
});

describe("text marks and ink on the slide", () => {
  const runs: TextRun[] = [
    { id: "t1", text: "Deltas", box: { x: 0.1, y: 0.2, w: 0.12, h: 0.06 } },
    { id: "t2", text: "grow", box: { x: 0.23, y: 0.2, w: 0.08, h: 0.06 } },
    { id: "t3", text: "slowly", box: { x: 0.1, y: 0.4, w: 0.12, h: 0.06 } },
  ];

  it("puts a mark on the boxes of its runs, a part of a run by character count", () => {
    expect(markBoxes([{ run: "t3" }], runs)).toEqual([runs[2]!.box]);
    const half = markBoxes([{ run: "t3", start: 3 }], runs)[0]!;
    expect(half.x).toBeCloseTo(0.16);
    expect(half.w).toBeCloseTo(0.06);
    expect(markBoxes([{ run: "nope" }], runs)).toEqual([]);
  });

  it("joins words on one line into one box, and keeps lines apart", () => {
    const line = markBoxes([{ run: "t1" }, { run: "t2" }], runs);
    expect(line).toHaveLength(1);
    expect(line[0]!.x).toBeCloseTo(0.1);
    expect(line[0]!.w).toBeCloseTo(0.21);
    expect(markBoxes([{ run: "t2" }, { run: "t3" }], runs)).toHaveLength(2);
  });

  it("draws each element at its fractions of the canvas: a dot for a single point, a stroke along its points, shapes in their box", () => {
    const calls: { name: string; args: number[] }[] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get:
        (_, name: string) =>
        (...args: number[]) =>
          calls.push({ name, args }),
      set: () => true,
    });
    /** Where the drawing calls in [from, to) put ink: the box of their x, y arguments. */
    const extent = (from: number, to: number) => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const c of calls.slice(from, to)) {
        if (["moveTo", "lineTo", "arc", "ellipse"].includes(c.name)) {
          xs.push(c.args[0]!);
          ys.push(c.args[1]!);
        } else if (c.name === "quadraticCurveTo") {
          xs.push(c.args[2]!);
          ys.push(c.args[3]!);
        } else if (c.name === "rect") {
          xs.push(c.args[0]!, c.args[0]! + c.args[2]!);
          ys.push(c.args[1]!, c.args[1]! + c.args[3]!);
        }
      }
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    const starts = () => calls.flatMap((c, i) => (c.name === "save" ? [i] : []));
    const style = {
      deck: 0,
      index: 0,
      tool: "pen",
      color: "#ff0000",
      width: 0.01,
      by: { id: "a", name: "A" },
    } as const;
    drawInk(
      ctx,
      [
        { ...style, kind: "stroke", stroke: "s1", done: true, points: [[0.5, 0.5]] },
        {
          ...style,
          kind: "stroke",
          stroke: "s2",
          done: false,
          points: [
            [0.1, 0.1],
            [0.2, 0.2],
            [0.3, 0.3],
          ],
        },
      ],
      1_000,
      500,
    );
    const [dot, line] = starts();
    const d = extent(dot!, line!);
    expect([d.x0, d.y0]).toEqual([500, 250]);
    const l = extent(line!, calls.length);
    // A stroke still being drawn: perfect-freehand's outline round 100,50 → 300,150, give or take its width.
    expect(l.x0).toBeGreaterThan(80);
    expect(l.x0).toBeLessThan(110);
    expect(l.x1).toBeGreaterThan(290);
    expect(l.x1).toBeLessThan(320);

    calls.length = 0;
    const { tool: _tool, ...colour } = style;
    const shape = {
      ...colour,
      kind: "shape" as const,
      stroke: "x",
      start: [0.1, 0.2] as Point,
      end: [0.3, 0.6] as Point,
    };
    drawInk(
      ctx,
      [
        { ...shape, shape: "rect" },
        { ...shape, shape: "ellipse" },
        { ...shape, shape: "arrow" },
      ],
      1_000,
      500,
    );
    const [rect, ellipse, arrow] = starts();
    expect(extent(rect!, ellipse!)).toEqual({ x0: 100, x1: 300, y0: 100, y1: 300 });
    expect(extent(ellipse!, arrow!)).toMatchObject({ x0: 200, y0: 200 }); // its centre
    const a = extent(arrow!, calls.length);
    expect([a.x0, a.y0]).toEqual([100, 100]);
    expect([a.x1, a.y1]).toEqual([300, 300]); // the head ends at the end point
  });
});

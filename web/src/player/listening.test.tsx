import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRoomService } from "../annotate/fake";
import type { CommentRecord, TextRun } from "../contracts/types";
import { DEMO_ROOM, DEMO_START_MS } from "../pages/DemoPage";
import { createDemoPlayback } from "../playback/usePlayback";
import { FakeTransport } from "../transport/fake";
import { DemoSlides } from "./demoSlides";
import { Player } from "./Player";
import { SlideTracks } from "./slideTracks";

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const W = 1600;
const H = 900;

/** The demo room in the player, with a room service in memory taking the listener's writes. */
function setup(service: FakeRoomService) {
  const playback = createDemoPlayback(DEMO_ROOM, DEMO_START_MS);
  const script = new DemoSlides(DEMO_ROOM, 3_600_000);
  script.start(DEMO_START_MS);
  const slides = new SlideTracks(script.source, DEMO_ROOM, { catalog: () => script.catalog });
  const timer = setInterval(() => script.advanceTo(playback.liveEdge() ?? DEMO_START_MS), 50);
  service.setNow(DEMO_START_MS);
  const view = render(
    <Player
      playback={playback}
      slides={slides}
      room={DEMO_ROOM}
      transport={new FakeTransport()}
      sources={["slides"]}
      roomService={service}
    />,
  );
  return {
    slides,
    runs: (): readonly TextRun[] => {
      const on = slides.slideAt(undefined)?.slide;
      return on ? (slides.picture(on.deck, on.index)?.image.runs ?? []) : [];
    },
    close() {
      view.unmount();
      clearInterval(timer);
      slides.close();
      playback.close();
    },
  };
}

/** The tools' surface over the slide, laid out at W × H. */
function surface(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".tt-annotate-surface");
  if (!el) throw new Error("no annotation surface");
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return el;
}

function drag(from: [number, number], to: [number, number]) {
  const el = surface();
  fireEvent.pointerDown(el, { clientX: from[0] * W, clientY: from[1] * H, button: 0, pointerId: 1 });
  fireEvent.pointerMove(el, {
    clientX: ((from[0] + to[0]) / 2) * W,
    clientY: ((from[1] + to[1]) / 2) * H,
    pointerId: 1,
  });
  fireEvent.pointerMove(el, { clientX: to[0] * W, clientY: to[1] * H, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: to[0] * W, clientY: to[1] * H, pointerId: 1 });
}

const tool = (name: string) => screen.getByRole("button", { name });

describe("a listener annotating and commenting (decision 0024)", () => {
  let close: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
    HTMLElement.prototype.setPointerCapture ??= () => {};
  });
  afterEach(() => {
    close?.();
    close = undefined;
    vi.useRealTimers();
  });

  it("draws, underlines and comments on the live slide, all as writes to the room service", async () => {
    const service = new FakeRoomService({ me: { id: "u1", name: null, speaker: false } });
    const room = setup(service);
    close = room.close;
    await advance(300);

    fireEvent.click(tool("Annotate"));
    // A display name is asked once, before anything goes out.
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(tool("OK"));
    await advance(50);

    drag([0.2, 0.6], [0.4, 0.7]);
    const ink = service.writes.filter((w) => w.track === "ink").map((w) => w.data);
    expect(ink.map((d) => d.kind)).toEqual(["begin", "points", "end"]);
    expect(ink[0]).toMatchObject({ deck: 0, index: 4, tool: "pen" });
    expect(String(ink[0]!.stroke).startsWith("u1:")).toBe(true);

    const run = room.runs()[0]!;
    fireEvent.click(tool("Underline"));
    drag([run.box.x + 0.001, run.box.y + run.box.h / 2], [run.box.x + run.box.w, run.box.y + run.box.h / 2]);
    const mark = service.writes.find((w) => w.track === "marks")?.data;
    expect(mark).toMatchObject({ kind: "mark", style: "underline", deck: 0, index: 4 });
    expect(mark?.span).toEqual([expect.objectContaining({ run: run.id })]);

    fireEvent.click(tool("Comment"));
    drag([0.6, 0.6], [0.8, 0.8]);
    await advance(50);
    expect(screen.getByRole("tab", { name: "Discussion" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Why does it bend here?" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Question for the speaker/ }));
    await act(async () => fireEvent.click(tool("Post")));
    const posted = service.writes.find((w) => w.track === "comments")!;
    expect(posted.at).toBeUndefined(); // live: the room service stamps it now
    expect(posted.data).toMatchObject({ kind: "comment", question: true, anchor: { deck: 0, index: 4 } });
    expect((posted.data.anchor as { region?: object }).region).toMatchObject({ x: 0.6, y: 0.6 });

    // It comes back in the room's threads: listed in the tab and marked on the slide.
    await advance(50);
    const threads = screen.getByRole("list", { name: "Threads" });
    expect(within(threads).getByText("Why does it bend here?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Comment by Ada: Why does it bend here\?/ })).toBeTruthy();
  });

  it("while rewound draws nothing, and a comment goes out at the playhead's room time", async () => {
    const service = new FakeRoomService({ me: { id: "u1", name: "Ada", speaker: false } });
    const room = setup(service);
    close = room.close;
    await advance(300);
    for (let i = 0; i < 4; i++) fireEvent.keyDown(document.body, { key: "j" });
    await advance(500);

    fireEvent.click(tool("Annotate"));
    expect((tool("Pen") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".tt-annotate-surface")).toBeNull();
    expect(screen.getByText(/Go live to draw/)).toBeTruthy();

    service.setNow(DEMO_START_MS + 1_000);
    fireEvent.click(screen.getByRole("tab", { name: "Discussion" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Back to this one" } });
    await act(async () => fireEvent.click(tool("Post")));
    const posted = service.writes.find((w) => w.track === "comments")!;
    expect(posted.at).toBeGreaterThan(DEMO_START_MS - 50_000);
    expect(posted.at).toBeLessThan(DEMO_START_MS - 30_000);
    expect(posted.data.anchor).toEqual({ deck: 0, index: 3 }); // the slide seen then, the fourth

    // A reply made later (the speaker's) is counted, not shown, at this point of the replay.
    const comment = service.threads().find((r) => r.data.kind === "comment")!.data as { id: string };
    const later: CommentRecord = {
      m: DEMO_START_MS + 2_000,
      data: {
        kind: "reply",
        id: "c9",
        to: comment.id,
        at: DEMO_START_MS + 2_000,
        text: "Good question",
        by: { id: "speaker", name: "Dr. Lee", speaker: true },
      },
    };
    act(() => service.push(later));
    expect(screen.getByText("1 later reply")).toBeTruthy();
    expect(screen.queryByText("Good question")).toBeNull();
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DECK_TRACK, INK_TRACK, MARKS_TRACK, POINTER_TRACK, SLIDE_TRACK } from "../contracts/names";
import type { CurrentSlideRecord, InkRecord, MarkRecord, PointerRecord } from "../contracts/types";
import {
  parseCurrentSlideObject,
  parseDeckObject,
  parseInkObject,
  parseMarksObject,
  parsePointerObject,
} from "../contracts/validate";
import { FakeRoomService } from "../annotate/fake";
import { FakeTransport } from "../transport/fake";
import { localEpoch } from "./clock";
import { Console, type ConsoleDeps } from "./Console";
import type { Deck, RenderedSlide } from "./deck";
import type { MediaSnapshot, SpeakerMedia } from "./media";
import { MemoryBroadcast } from "./sink";
import { CHALK_BOX, inkColor } from "../theme/ink";

function fakeDeck(count = 3): Deck {
  return {
    name: "viruses.pdf",
    title: "Viruses",
    count,
    aspect: 16 / 9,
    fingerprint: "test-deck",
    render: async (index): Promise<RenderedSlide> => {
      const runs = [{ id: "t0", text: `Slide ${index} title`, box: { x: 0.1, y: 0.1, w: 0.6, h: 0.1 } }];
      return {
        index,
        runs,
        url: `blob:slide-${index}`,
        image: { kind: "image", index, mime: "image/webp", width: 1600, height: 900, data_b64: "UklGRg==", runs },
        frame: { mime: "image/jpeg", data_b64: "/9j/4A==" },
      };
    },
    close: () => undefined,
  };
}

/** Microphone and camera without devices: on air is a flag. */
function fakeMedia(): SpeakerMedia & { closed: boolean } {
  const listeners = new Set<(s: MediaSnapshot) => void>();
  let s: MediaSnapshot = {
    micOn: false,
    cameraOn: false,
    micTrack: undefined,
    cameraTrack: undefined,
    micError: undefined,
    cameraError: undefined,
    micDevices: [],
    cameraDevices: [],
    micDevice: undefined,
    cameraDevice: undefined,
    onAir: false,
  };
  const set = (patch: Partial<MediaSnapshot>) => {
    s = { ...s, ...patch };
    for (const fn of listeners) fn(s);
  };
  return {
    closed: false,
    snapshot: () => s,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setMic: (micOn) => set({ micOn }),
    setCamera: (cameraOn) => set({ cameraOn }),
    chooseMic: () => undefined,
    chooseCamera: () => undefined,
    goOnAir: () => set({ onAir: true }),
    goOffAir: () => set({ onAir: false }),
    shareScreen: async (withAudio) =>
      set({ screenTrack: { kind: "video" } as MediaStreamTrack, screenAudio: withAudio }),
    stopScreen: () => set({ screenTrack: undefined, screenAudio: false }),
    close() {
      this.closed = true;
    },
  };
}

function setup(extra: Partial<ConsoleDeps> = {}) {
  const sinks: MemoryBroadcast[] = [];
  const deps: ConsoleDeps = {
    watcher: new FakeTransport(),
    makeSink: () => {
      const s = new MemoryBroadcast();
      sinks.push(s);
      return s;
    },
    openDeck: async () => fakeDeck(),
    localEpochMs: localEpoch(Date.now()),
    ...extra,
  };
  render(<Console room="physics-101" token={undefined} deps={deps} />);
  const sink = () => sinks.at(-1)!;
  const all = <R,>(track: string) =>
    sink()
      .written.filter((o) => o.track === track)
      .flatMap((o) => JSON.parse(new TextDecoder().decode(o.payload)) as R[]);
  return { sink, all };
}

async function loadDeck() {
  const input = screen.getByTestId("deck-file");
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File(["%PDF"], "viruses.pdf", { type: "application/pdf" })] } });
  });
  await waitFor(() => expect(screen.getByTestId("slide-count").textContent).toBe("1 / 3"));
}

function stage() {
  const canvas = screen.getByTestId("stage");
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1600,
    height: 900,
    right: 1600,
    bottom: 900,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return canvas;
}

const PARSE: Record<string, (p: Uint8Array) => { ok: boolean }> = {
  [DECK_TRACK]: parseDeckObject,
  [SLIDE_TRACK]: parseCurrentSlideObject,
  [INK_TRACK]: parseInkObject,
  [MARKS_TRACK]: parseMarksObject,
  [POINTER_TRACK]: parsePointerObject,
};

describe("the speaker console", () => {
  it("loads a deck and moves through it with slide keys and clickers, publishing each slide shown", async () => {
    const { all, sink } = setup();
    await loadDeck();
    await waitFor(() => expect(sink().groups(DECK_TRACK)).toHaveLength(1));
    await act(async () => fireEvent.keyDown(window, { key: "ArrowRight" }));
    await waitFor(() => expect(screen.getByTestId("slide-count").textContent).toBe("2 / 3"));
    await act(async () => fireEvent.keyDown(window, { key: "PageDown" }));
    await waitFor(() => expect(screen.getByTestId("slide-count").textContent).toBe("3 / 3"));
    await act(async () => fireEvent.keyDown(window, { key: "PageUp" }));
    await waitFor(() => expect(screen.getByTestId("slide-count").textContent).toBe("2 / 3"));
    await act(async () => fireEvent.keyDown(window, { key: "b" }));

    const shown = all<CurrentSlideRecord>(SLIDE_TRACK).map((r) => (r.data.kind === "show" ? r.data.index : "hide"));
    expect(shown.filter((v, i) => v !== shown[i - 1])).toEqual([0, 1, 2, 1, "hide"]);
  });

  it("keeps notes private: typing them publishes nothing", async () => {
    const { sink } = setup();
    await loadDeck();
    const before = sink().written.length;
    fireEvent.change(screen.getByLabelText(/Your notes for slide 1/), { target: { value: "Mention the 1918 flu" } });
    expect(sink().written.length).toBe(before);
    expect(JSON.stringify(sink().objects(SLIDE_TRACK, sink().groups(SLIDE_TRACK)[0]!))).not.toContain("1918");
  });

  it("draws with the pen, points the laser, underlines text and clears the slide, all as contract records", async () => {
    const { all, sink } = setup();
    await loadDeck();
    const canvas = stage();

    await act(async () => fireEvent.keyDown(window, { key: "d" }));
    fireEvent.pointerDown(canvas, { clientX: 160, clientY: 450, button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 400, clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 500, pointerId: 1 });

    await act(async () => fireEvent.keyDown(window, { key: "l" }));
    fireEvent.pointerDown(canvas, { clientX: 800, clientY: 450, button: 0, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 800, clientY: 450, pointerId: 1 });

    await act(async () => fireEvent.keyDown(window, { key: "u" }));
    fireEvent.pointerDown(canvas, { clientX: 170, clientY: 130, button: 0, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 1100, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 1100, clientY: 130, pointerId: 1 });

    const ink = all<InkRecord>(INK_TRACK).map((r) => r.data);
    expect(ink.map((d) => d.kind).filter((k) => k !== "points")).toEqual(["begin", "end"]);
    expect(ink[0]).toMatchObject({ kind: "begin", tool: "pen", deck: 0, index: 0, points: [[0.1, 0.5]] });
    expect(ink[0]?.kind === "begin" && ink[0].by).toEqual({ id: "speaker", name: "Speaker", speaker: true });
    expect(all<PointerRecord>(POINTER_TRACK).map((r) => r.data.kind)).toEqual(["at", "at", "off"]);
    const marks = all<MarkRecord>(MARKS_TRACK).map((r) => r.data);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ kind: "mark", style: "underline", span: [{ run: "t0" }] });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear slide" })));
    expect(all<InkRecord>(INK_TRACK).at(-1)?.data.kind).toBe("clear");
    expect(all<MarkRecord>(MARKS_TRACK).at(-1)?.data.kind).toBe("clear");

    for (const o of sink().written) {
      const parse = PARSE[o.track];
      if (parse) expect(parse(o.payload).ok, `${o.track} ${o.group}/${o.object}`).toBe(true);
    }
  });

  it("opens a tool's colour and width from the tool, closes them when drawing, and draws in the colour picked", async () => {
    const { all } = setup();
    await loadDeck();
    const canvas = stage();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pen (D)" })));
    const options = screen.getByRole("group", { name: "Pen options" });
    const radios = within(options).getAllByRole("radio");
    // Every chalk for the pen, and the three widths.
    expect(radios.length).toBeGreaterThan(3);
    const picked = within(within(options).getByRole("radiogroup", { name: "Colour" })).getAllByRole("radio")[2]!;
    fireEvent.click(picked);

    fireEvent.pointerDown(canvas, { clientX: 160, clientY: 450, button: 0, pointerId: 1 });
    expect(screen.queryByRole("group", { name: "Pen options" })).toBeNull();
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 450, pointerId: 1 });
    const begin = all<InkRecord>(INK_TRACK).find((r) => r.data.kind === "begin")?.data;
    const chalk = CHALK_BOX.find((i) => i.label === picked.getAttribute("aria-label"))!;
    expect(begin?.kind === "begin" && begin.color).toBe(inkColor(chalk.name));

    fireEvent.click(screen.getByRole("button", { name: "Pen colour and width" }));
    expect(screen.getByRole("group", { name: "Pen options" })).toBeTruthy();
  });

  it("pauses the broadcast and resumes it, keeping the talk going", async () => {
    const media = fakeMedia();
    setup({ createMedia: async () => media });
    await loadDeck();
    const goLive = await screen.findByRole("button", { name: "Go on air" });
    await waitFor(() => expect(goLive.hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(goLive));
    expect(media.snapshot().onAir).toBe(true);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pause" })));
    expect(media.snapshot().onAir).toBe(false);
    expect(media.closed).toBe(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resume" })));
    expect(media.snapshot().onAir).toBe(true);
    expect(screen.getByRole("button", { name: "End talk" })).toBeTruthy();
  });

  it("shares a screen with its sound in place of the slides, and stops sharing", async () => {
    const media = fakeMedia();
    setup({ createMedia: async () => media });
    await loadDeck();
    const share = await screen.findByRole("button", { name: "Share screen" });
    await waitFor(() => expect(share.hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("switch", { name: "With its sound" }));
    await act(async () => fireEvent.click(share));
    expect(media.snapshot()).toMatchObject({ screenAudio: true });
    expect(screen.getByLabelText("Your shared screen")).toBeTruthy(); // what viewers see now

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop sharing" })));
    expect(media.snapshot().screenTrack).toBeUndefined();
    expect(screen.queryByLabelText("Your shared screen")).toBeNull();
    expect(screen.getByTestId("stage")).toBeTruthy(); // the slides are back
  });

  it("shows the invitation with the room's watch link", () => {
    setup();
    expect(screen.getAllByRole("img", { name: /QR code for .*\/watch\/physics-101/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("goes on air with the microphone, and ends the talk only after one confirmation", async () => {
    const media = fakeMedia();
    let ended = 0;
    const { sink } = setup({ createMedia: async () => media, endRoom: async () => (ended++, true) });
    await loadDeck();
    const goLive = await screen.findByRole("button", { name: "Go on air" });
    await waitFor(() => expect(goLive.hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(goLive));
    expect(media.snapshot()).toMatchObject({ micOn: true, onAir: true });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "End talk" })));
    expect(sink().closed).toBe(false);
    expect(ended).toBe(0);
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "End talk" })));
    await screen.findByText("What is kept");
    expect(ended).toBe(1); // the room service is told, so the room says "ended" rather than "paused"
    expect(sink().closed).toBe(true);
    expect(media.closed).toBe(true);
  });
  it("says Ending… until the room service acknowledges the end, trying again while the message is lost", async () => {
    const media = fakeMedia();
    const answers = [false, false, true]; // the socket is down twice, then the service acknowledges
    let tries = 0;
    let forgotten = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    setup({
      createMedia: async () => media,
      endRoom: async () => {
        if (tries === 2) await held; // the third try waits for the service
        return answers[tries++]!;
      },
      endRetryMs: 1,
      onEnded: () => forgotten++,
    });
    const goLive = await screen.findByRole("button", { name: "Go on air" });
    await waitFor(() => expect(goLive.hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(goLive));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "End talk" })));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "End talk" })));

    await waitFor(() => expect(tries).toBe(2));
    expect(screen.getByRole("status").textContent).toContain("Ending…");
    expect(forgotten).toBe(0); // the link is kept until the end is said
    await act(async () => release());
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Ended"));
    expect(tries).toBe(3);
    expect(forgotten).toBe(1);
  });

  it("lists the audience's questions, counts them per slide, and replies to or hides one as the speaker", async () => {
    const ada = { id: "u1", name: "Ada" };
    const service = new FakeRoomService({ me: { id: "speaker", name: "Speaker", speaker: true }, now: 60_000 });
    const { sink } = setup({ makeRoomService: () => service });
    await loadDeck();
    // The audience anchors questions on the deck the console published. Its id is the room-clock slice it went out
    // in, so it is 0 only when the deck loads within the room's first 4 s: read it, never assume it.
    await waitFor(() => expect(sink().groups(DECK_TRACK)).toHaveLength(1));
    const deck = sink().groups(DECK_TRACK)[0]!;
    act(() =>
      service.push(
        {
          m: 50_000,
          data: {
            kind: "comment",
            id: "c1",
            at: 50_000,
            text: "Is RNA a virus?",
            by: ada,
            question: true,
            anchor: { deck, index: 1 },
          },
        },
        {
          m: 55_000,
          data: { kind: "comment", id: "c2", at: 55_000, text: "Nice slide", by: ada, anchor: { deck, index: 1 } },
        },
      ),
    );
    const list = screen.getByRole("region", { name: "Questions from the audience" });
    expect(within(list).getByText("Is RNA a virus?")).toBeTruthy();
    expect(within(list).queryByText("Nice slide")).toBeNull(); // a comment, not a question
    expect(screen.getByRole("button", { name: "Show slide 2, 1 questions" })).toBeTruthy();

    fireEvent.change(within(list).getByRole("textbox", { name: "Reply to Ada" }), {
      target: { value: "It carries one" },
    });
    await act(async () => fireEvent.click(within(list).getByRole("button", { name: "Reply" })));
    expect(service.writes.at(-1)).toEqual({
      track: "comments",
      data: { kind: "reply", to: "c1", text: "It carries one" },
    });
    expect(within(list).getByText(/It carries one/)).toBeTruthy();

    await act(async () => fireEvent.click(within(list).getByRole("button", { name: "Hide" })));
    expect(service.writes.at(-1)).toEqual({ track: "comments", data: { kind: "hide", id: "c1" } });
    expect(within(list).queryByText("Is RNA a virus?")).toBeNull();
  });
});

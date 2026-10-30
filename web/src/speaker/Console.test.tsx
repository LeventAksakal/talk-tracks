import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DECK_TRACK, INK_TRACK, MARKS_TRACK, POINTER_TRACK, SLIDE_TRACK } from "../contracts/names";
import type { CurrentSlideRecord, InkRecord, MarkRecord, PointerRecord } from "../contracts/types";
import { parseCurrentSlideObject, parseDeckObject, parseInkObject, parseMarksObject, parsePointerObject } from "../contracts/validate";
import { FakeTransport } from "../transport/fake";
import { localEpoch } from "./clock";
import { Console, type ConsoleDeps } from "./Console";
import type { Deck, RenderedSlide } from "./deck";
import type { MediaSnapshot, SpeakerMedia } from "./media";
import { MemoryBroadcast } from "./sink";

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
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) });
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

  it("shows the invitation with the room's watch link", () => {
    setup();
    expect(screen.getAllByRole("img", { name: /QR code for .*\/watch\/physics-101/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("goes on air with the microphone, and ends the talk only after one confirmation", async () => {
    const media = fakeMedia();
    const { sink } = setup({ createMedia: async () => media });
    await loadDeck();
    const goLive = await screen.findByRole("button", { name: "Go on air" });
    await waitFor(() => expect(goLive.hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(goLive));
    expect(media.snapshot()).toMatchObject({ micOn: true, onAir: true });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "End talk" })));
    expect(sink().closed).toBe(false);
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "End talk" })));
    await screen.findByText("What is kept");
    expect(sink().closed).toBe(true);
    expect(media.closed).toBe(true);
  });
});

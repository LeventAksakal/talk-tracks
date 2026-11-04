import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SLIDE_TRACK } from "../contracts/names";
import type { CurrentSlideRecord } from "../contracts/types";
import type { Deck, RenderedSlide } from "./deck";
import { SlidesPublisher } from "./publisher";
import { MemoryBroadcast } from "./sink";
import { SlidesSetup } from "./SlidesSetup";

function fakeDeck(count: number): Deck {
  return {
    name: "qr-codes.pptx",
    title: "QR codes",
    count,
    aspect: 16 / 9,
    fingerprint: "test-deck",
    render: async (index): Promise<RenderedSlide> => ({
      index,
      runs: [],
      url: `blob:slide-${index}`,
      image: { kind: "image", index, mime: "image/webp", width: 1600, height: 900, data_b64: "UklGRg==", runs: [] },
      frame: { mime: "image/jpeg", data_b64: "/9j/4A==" },
    }),
    thumbnail: async (index) => `blob:thumb-${index}`,
    close: () => undefined,
  };
}

function setup(live: boolean) {
  const sink = new MemoryBroadcast();
  const clock = { t: 10_000 };
  const publisher = new SlidesPublisher(sink, { id: "speaker", name: "Ada", speaker: true }, "test");
  if (live) publisher.goLive(() => clock.t);
  const shown: number[] = [];
  const ui = render(
    <SlidesSetup
      publisher={publisher}
      live={live}
      openDeck={async () => fakeDeck(5)}
      onShown={(s) => shown.push(s.index)}
    />,
  );
  /** The slide the slides track says viewers see. */
  const onAir = () =>
    sink.written
      .filter((o) => o.track === SLIDE_TRACK)
      .flatMap((o) => JSON.parse(new TextDecoder().decode(o.payload)) as CurrentSlideRecord[])
      .at(-1)?.data;
  return { sink, clock, publisher, shown, onAir, ui };
}

async function addDeck() {
  await act(async () => {
    fireEvent.change(screen.getByTestId("slides-file"), {
      target: { files: [new File(["%PDF"], "qr-codes.pptx")] },
    });
  });
}

describe("adding and choosing slides", () => {
  it("lists every slide of the deck and previews the first", async () => {
    setup(false);
    await addDeck();
    expect(screen.getAllByRole("button", { name: /^Slide \d+$/ })).toHaveLength(5);
    expect(screen.getByTestId("slides-count").textContent).toBe("Slide 1 of 5");
    expect(screen.getByTestId("slides-current").getAttribute("src")).toBe("blob:slide-0");
  });

  it("on air, choosing slide 3 shows slide 3 to viewers", async () => {
    const { onAir, shown } = setup(true);
    await addDeck();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Slide 3" }));
    });
    expect(onAir()).toMatchObject({ kind: "show", index: 2 });
    expect(shown.at(-1)).toBe(2);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    });
    expect(onAir()).toMatchObject({ kind: "show", index: 3 });
  });

  it("before air nothing is sent; the chosen slide goes out when the talk goes live", async () => {
    const { sink, publisher, clock, onAir } = setup(false);
    await addDeck();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Slide 4" }));
    });
    expect(sink.written).toHaveLength(0);
    publisher.goLive(() => clock.t);
    expect(onAir()).toMatchObject({ kind: "show", index: 3 });
  });

  it("says why a file could not be opened", async () => {
    const sink = new MemoryBroadcast();
    const publisher = new SlidesPublisher(sink, { id: "speaker", name: "Ada", speaker: true }, "test");
    render(<SlidesSetup publisher={publisher} live={false} />);
    await act(async () => {
      fireEvent.change(screen.getByTestId("slides-file"), { target: { files: [new File(["x"], "talk.key")] } });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/export.*PDF/i);
  });
});

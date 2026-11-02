import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRoomService } from "../annotate/fake";
import { DEMO_ROOM, DEMO_START_MS } from "../pages/DemoPage";
import { createDemoPlayback } from "../playback/usePlayback";
import { FakeTransport } from "../transport/fake";
import { DemoSlides } from "./demoSlides";
import { Player, type PlayerProps } from "./Player";
import { SlideTracks } from "./slideTracks";
import { playerState } from "./state";

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** The scripted room in the player, its slides shown, with whatever else a test passes. */
function setup(props: Partial<PlayerProps> = {}) {
  const playback = createDemoPlayback(DEMO_ROOM, DEMO_START_MS);
  const script = new DemoSlides(DEMO_ROOM, 3_600_000);
  script.start(DEMO_START_MS);
  const slides = new SlideTracks(script.source, DEMO_ROOM, { catalog: () => script.catalog });
  const timer = setInterval(() => script.advanceTo(playback.liveEdge() ?? DEMO_START_MS), 50);
  const view = render(
    <Player
      playback={playback}
      slides={slides}
      room={DEMO_ROOM}
      transport={new FakeTransport()}
      sources={["slides"]}
      {...props}
    />,
  );
  return {
    playback,
    close() {
      view.unmount();
      clearInterval(timer);
      slides.close();
      playback.close();
    },
  };
}

const openDiscussion = () => {
  if (!screen.queryByRole("tablist")) fireEvent.click(screen.getByRole("button", { name: /Side panel/ }));
  fireEvent.click(screen.getByRole("tab", { name: "Discussion" }));
};

describe("the player shell", () => {
  let close: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  });
  afterEach(() => {
    close?.();
    close = undefined;
    vi.useRealTimers();
  });

  it("offers no annotation tools where the room service cannot be reached, says why, and brings them back", async () => {
    const service = new FakeRoomService({ status: "waiting" });
    const room = setup({ roomService: service });
    close = room.close;
    await advance(300);
    expect(screen.queryByRole("button", { name: "Annotate" })).toBeNull();
    openDiscussion();
    expect(within(screen.getByRole("tabpanel")).getByRole("status").textContent).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();

    act(() => service.setStatus("open"));
    await advance(50);
    expect(screen.getByRole("button", { name: "Annotate" })).toBeTruthy();
  });

  it("in a room with no room service at all (a demo room), the Discussion tab explains and nothing can be written", async () => {
    const room = setup({ noRoomService: "No room service here." });
    close = room.close;
    await advance(300);
    expect(screen.queryByRole("button", { name: "Annotate" })).toBeNull();
    openDiscussion();
    expect(within(screen.getByRole("tabpanel")).getByRole("status").textContent).toBe("No room service here.");
  });

  it("shows an ended talk as a recording of known length that replays from the start", async () => {
    const room = setup({ forceState: "ended" });
    close = room.close;
    await advance(300);
    const time = screen.getByLabelText("Time in the talk");
    expect(time.textContent).toContain("/");
    fireEvent.click(screen.getByRole("button", { name: "Replay from the start" }));
    await advance(300);
    expect(room.playback.media.mode()).toBe("rewound");
    expect(room.playback.position()).toBeLessThan(DEMO_START_MS);
  });

  it("names the talk and its speaker as the room track says them, over what the page passed", async () => {
    // The scripted room's room track says "How rivers shape the land" by "Demo speaker".
    const room = setup({ title: "A page title", speaker: "Grace" });
    close = room.close;
    await advance(300);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("How rivers shape the land");
    expect(screen.getByText(/Demo speaker/)).toBeTruthy();
    expect(screen.queryByText(/Grace/)).toBeNull();
  });

  it("gives the skip link a main landmark: the talk, its canvas and its controls", async () => {
    const room = setup();
    close = room.close;
    await advance(300);
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(within(main).getByRole("slider", { name: "Position in the talk" })).toBeTruthy();
  });

  it("reaches every side panel tab by keyboard, and closes the panel from outside the tab list", async () => {
    const room = setup({ noRoomService: "No room service here." });
    close = room.close;
    await advance(300);
    if (!screen.queryByRole("tablist")) fireEvent.click(screen.getByRole("button", { name: /Side panel/ }));
    const list = screen.getByRole("tablist", { name: "Side panel" });
    // A tab list holds tabs only.
    expect(within(list).queryAllByRole("button")).toEqual([]);
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toContain("Discussion");
    // Arrow keys walk the tabs to the last one.
    act(() => tabs[0]!.focus());
    for (let i = 1; i < tabs.length; i++) fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs.at(-1));
    expect(tabs.at(-1)!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close the side panel" }));
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("puts a shared screen on the main stage with the camera in the corner, and lets the listener swap them", async () => {
    const room = setup({ sources: ["camera", "slides", "screen"] });
    close = room.close;
    await advance(300);
    expect(screen.getByRole("group", { name: "Shared screen" })).toBeTruthy();
    // The corner tile is the camera; swapping puts the screen there.
    fireEvent.click(screen.getByRole("button", { name: "Swap: screen in the corner" }));
    expect(screen.getByRole("button", { name: "Swap: camera in the corner" })).toBeTruthy();
  });

  it("lets the listener pick the slides as the main picture while a screen is shared, and the screen back", async () => {
    const room = setup({ sources: ["camera", "slides", "screen"] });
    close = room.close;
    await advance(300);
    fireEvent.click(screen.getByRole("button", { name: "Layout" }));
    let menu = screen.getByRole("dialog", { name: "Layout" });
    // The layouts name the shared screen, the main picture now.
    expect(within(menu).getByRole("button", { name: /screen.*camera in a corner/i })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("button", { name: "Slides" }));
    await advance(300);
    // The slides are the main picture: the corner tile (the camera) swaps with them now.
    expect(screen.getByRole("button", { name: "Swap: slides in the corner" })).toBeTruthy();
    expect(within(menu).getByRole("button", { name: /slides.*camera in a corner/i })).toBeTruthy();

    menu = screen.getByRole("dialog", { name: "Layout" });
    fireEvent.click(within(menu).getByRole("button", { name: "Screen" }));
    expect(screen.getByRole("button", { name: "Swap: screen in the corner" })).toBeTruthy();
  });
});

describe("the slower path", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("says so in the pill while the relay connection runs over the WebSocket fallback", async () => {
    class OverWebSocket extends FakeTransport {
      wire = () => "websocket" as const;
    }
    const room = setup({ transport: new OverWebSocket() });
    await advance(300);
    const pill = [...document.querySelectorAll('[role="status"]')].find((el) => el.textContent?.startsWith("LIVE"));
    expect(pill?.textContent).toContain("WebSocket");
    room.close();
  });
});

describe("player states the shell drives", () => {
  const base = { connection: "connected", everConnected: true, mode: "live", liveEdge: 60_000, behindMs: 0 } as const;

  it("marks live over WebSocket as the slower path", () => {
    expect(playerState({ ...base, onAir: true, room: "on_air", slowerPath: true }).pill).not.toBe(
      playerState({ ...base, onAir: true, room: "on_air" }).pill,
    );
  });

  it("gives an ended room its recording's span and a replay, live or rewound", () => {
    const ended = playerState({ ...base, onAir: false, room: "ended", recording: { start: 0, end: 1_020_000 } });
    expect(ended.kind).toBe("ended");
    expect(ended.recording).toEqual({ start: 0, end: 1_020_000 });
    expect(ended.card?.replay).toBe(true);
    expect(ended.card?.body).toContain("17:00");
    const rewound = playerState({
      ...base,
      mode: "rewound",
      behindMs: 600_000,
      room: "ended",
      roomAt: "on_air",
      onAir: false,
      recording: { start: 0, end: 1_020_000 },
    });
    expect(rewound.kind).toBe("ended");
    expect(rewound.card).toBeUndefined();
    expect(rewound.canGoLive).toBe(false);
  });
});

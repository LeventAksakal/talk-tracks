import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomServiceClient, type WebSocketLike } from "../annotate/client";
import { FakeRoomService } from "../annotate/fake";
import { catalogPath, ROOM_TRACK } from "../contracts/names";
import { DEMO_ROOM, DEMO_START_MS } from "../pages/DemoPage";
import { FakeHistorySource } from "../playback/fakeSource";
import { ClockMedia } from "../playback/media";
import { Playback } from "../playback/playback";
import { createDemoPlayback } from "../playback/usePlayback";
import { FakeTransport } from "../transport/fake";
import { DemoSlides } from "./demoSlides";
import { Player, type PlayerProps } from "./Player";
import { SlideTracks } from "./slideTracks";
import type { RoomMediaElement } from "./roomMediaElement";
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

const openDiscussion = () => fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
const discussion = () => screen.getByRole("region", { name: "Discussion" });

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
    expect(within(discussion()).getByRole("status").textContent).toBeTruthy();
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
    expect(within(discussion()).getByRole("status").textContent).toBe("No room service here.");
  });

  it("shows an ended talk as a recording of known length that replays from the start", async () => {
    const room = setup({ forceState: "ended" });
    close = room.close;
    await advance(300);
    // A recording: Media Chrome shows its length beside the time, and the range spans it.
    const media = document.querySelector<RoomMediaElement>("tt-room-media")!;
    expect(media.streamType).toBe("on-demand");
    expect(Number.isFinite(media.duration) && media.duration > 0).toBe(true);
    expect(document.querySelector("media-time-display")?.hasAttribute("showduration")).toBe(true);
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
    expect(main.querySelector("media-controller tt-room-media .tt-stage")).toBeTruthy();
    expect(main.querySelector("media-controller media-time-range")).toBeTruthy();
    expect(main.querySelector("media-controller media-play-button")).toBeTruthy();
  });

  it("opens one reading panel at a time in the side card from its button, and closes it from its title bar", async () => {
    const room = setup({ noRoomService: "No room service here." });
    close = room.close;
    await advance(300);
    const panels = screen.getByRole("group", { name: "Side panels" });
    // Listeners only listen and read: no microphone, camera or hand.
    expect(
      within(panels)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(expect.arrayContaining(["Transcript", "Chapters", "Discussion"]));
    expect(screen.queryByRole("button", { name: /microphone|camera|raise hand/i })).toBeNull();
    const button = (name: string) => within(panels).getByRole("button", { name });
    fireEvent.click(button("Transcript"));
    expect(button("Transcript").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("heading", { name: "Transcript" })).toBeTruthy();
    // Another panel takes the card's place.
    fireEvent.click(button("Discussion"));
    expect(screen.getByRole("heading", { name: "Discussion" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Transcript" })).toBeNull();
    expect(button("Transcript").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Close Discussion" }));
    expect(screen.queryByRole("heading", { name: "Discussion" })).toBeNull();
    // The button toggles: open, then closed again.
    fireEvent.click(button("Chapters"));
    expect(screen.getByRole("heading", { name: "Chapters" })).toBeTruthy();
    fireEvent.click(button("Chapters"));
    expect(screen.queryByRole("heading", { name: "Chapters" })).toBeNull();
  });

  it("floats the speaker in a small window without restarting it, docks it back, and keeps the layout", async () => {
    let room = setup({ sources: ["camera", "slides", "screen"] });
    close = room.close;
    await advance(300);
    expect(screen.getByRole("group", { name: "Shared screen" })).toBeTruthy();
    const camera = screen.getByRole("group", { name: "Speaker camera" });
    fireEvent.click(screen.getByRole("button", { name: "Move Speaker" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Float in a small window" }));
    const win = screen.getByRole("dialog", { name: "Speaker (floating)" });
    // The same picture, moved: the live canvas and the recording's sound never restart.
    expect(within(win).getByRole("group", { name: "Speaker camera" })).toBe(camera);
    // Kept per browser: a new page opens with the speaker still floating.
    room.close();
    room = setup({ sources: ["camera", "slides", "screen"] });
    close = room.close;
    await advance(300);
    expect(screen.getByRole("dialog", { name: "Speaker (floating)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move Speaker" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Dock left" }));
    expect(screen.queryByRole("dialog", { name: "Speaker (floating)" })).toBeNull();
    expect(document.querySelector(".tt-ws-zone[data-zone='left'] [data-panel='camera']")).toBeTruthy();
  });

  it("changes the view from More options, Adjust view, and resets the layout", async () => {
    const room = setup({ sources: ["camera", "slides"] });
    close = room.close;
    await advance(300);
    const shown = () =>
      ["Speaker camera", "Slides"].filter((name) => screen.queryByRole("group", { name }) !== null).length;
    // Auto: the slides and the speaker both on the stage.
    expect(screen.getByRole("group", { name: "Speaker camera" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Adjust view" }));
    const dialog = screen.getByRole("dialog", { name: "Adjust view" });
    const view = (name: string) => within(dialog).getByRole("radio", { name: new RegExp(`^${name}`) });
    expect(view("Auto").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(view("Spotlight"));
    expect(view("Spotlight").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("group", { name: "Speaker camera" })).toBeNull();
    fireEvent.click(view("Tiled"));
    expect(screen.getByRole("group", { name: "Speaker camera" })).toBeTruthy();
    // Moving a stream by hand leaves the views; Reset layout brings Auto back and forgets the saved one.
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Adjust view" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move Speaker" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Float in a small window" }));
    expect(screen.getByRole("dialog", { name: "Speaker (floating)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Adjust view" }));
    expect(
      within(screen.getByRole("dialog", { name: "Adjust view" })).queryByRole("radio", { checked: true }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(screen.queryByRole("dialog", { name: "Speaker (floating)" })).toBeNull();
    expect(shown()).toBeGreaterThanOrEqual(1);
    expect(localStorage.getItem("tt.workspace.v2")).toBeNull();
  });
});

describe("the slower path", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("says so in Stats for nerds, not in the pill, while the relay connection runs over the WebSocket fallback", async () => {
    class OverWebSocket extends FakeTransport {
      wire = () => "websocket" as const;
    }
    const room = setup({ transport: new OverWebSocket() });
    await advance(300);
    const pill = [...document.querySelectorAll('[role="status"]')].find((el) => el.textContent?.startsWith("LIVE"));
    expect(pill?.textContent).not.toContain("WebSocket");
    fireEvent.keyDown(document.body, { key: "i" });
    await advance(50);
    expect(within(screen.getByRole("region", { name: "Stats for nerds" })).getByText(/WebSocket/)).toBeTruthy();
    room.close();
  });
});

describe("a room on a connected relay, by what of it exists", () => {
  const NAME = "no-such-room";
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  let close: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    close?.();
    close = undefined;
    vi.useRealTimers();
  });

  /** A room service socket that answers every hello the way the room service answers for a room it does not hold. */
  function noRoomSocket(): WebSocketLike {
    const s: WebSocketLike = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) {
        if ((JSON.parse(data) as { type?: string }).type === "hello")
          s.onmessage?.({ data: JSON.stringify({ type: "error", code: "no-room", message: "not held" }) });
      },
      close() {
        s.readyState = 3;
        s.onclose?.({});
      },
    };
    setTimeout(() => {
      s.readyState = 1;
      s.onopen?.({});
    }, 0);
    return s;
  }

  /** The player on a relay that holds only what `source` publishes, with the room service answering no-room. */
  function open(source = new FakeHistorySource()) {
    const playback = new Playback(source, new ClockMedia(), NAME);
    const slides = new SlideTracks(source, NAME, { catalog: () => undefined });
    const service = new RoomServiceClient("ws://service/api/", NAME, { socket: noRoomSocket, retryMs: 500 });
    const view = render(
      <Player playback={playback} slides={slides} room={NAME} transport={new FakeTransport()} roomService={service} />,
    );
    close = () => {
      view.unmount();
      service.close();
      slides.close();
      playback.close();
    };
    return view;
  }
  const shown = (view: ReturnType<typeof render>) =>
    view.container.querySelector("[data-state]")?.getAttribute("data-state");

  it("says there is no such room a few seconds in, with the way back to the hub, and no outage", async () => {
    const view = open();
    await advance(1_000);
    expect(shown(view)).toBe("connecting");
    await advance(6_000);
    expect(shown(view)).toBe("unknown");
    const card = screen.getAllByRole("status").find((s) => s.textContent?.includes(NAME));
    expect(card).toBeTruthy();
    expect(within(card!).getByRole("link")).toBeTruthy();
    // The room service not holding the room is not the room service being down.
    expect(within(screen.getByRole("banner")).queryAllByRole("status")).toHaveLength(0);
  });

  it("reads a created room that has not started as not started, however long it waits", async () => {
    const source = new FakeHistorySource();
    source.announce(catalogPath(NAME));
    source.publish(catalogPath(NAME), ROOM_TRACK, 0, json([{ m: 0, data: { kind: "state", state: "waiting" } }]));
    const view = open(source);
    await advance(8_000);
    expect(shown(view)).toBe("not-started");
  });
});

describe("player states the shell drives", () => {
  const base = { connection: "connected", everConnected: true, mode: "live", liveEdge: 60_000, behindMs: 0 } as const;

  it("marks live over WebSocket as the slower path, outside the pill", () => {
    const slower = playerState({ ...base, onAir: true, room: "on_air", slowerPath: true });
    expect(slower.slowerPath).toBe(true);
    expect(slower.pill).toBe(playerState({ ...base, onAir: true, room: "on_air" }).pill);
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

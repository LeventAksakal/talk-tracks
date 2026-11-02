import { describe, expect, it } from "vitest";
import type { TrackView } from "../playback/aiTracks";
import type { LineItem } from "../playback/wire";
import { languageOption, searchLanguages } from "./languages";
import { cameraNote } from "./CameraSurface";
import { DEFAULT_PREFS, readPrefs } from "./prefs";
import { playerState, type PlayerStateInput } from "./state";
import { cuesAt } from "./subtitles";
import { dragSubtitle } from "./SubtitleOverlay";
import { chapterAt, chapterSegments, holesIn } from "./timeline";
import { Linger, openTab, roomTracks, wantedTracks } from "./tracks";

const line = (id: number, startMs: number, final = true): LineItem => ({
  type: "line",
  id: String(id),
  startMs,
  endMs: startMs + 3_000,
  text: `line ${id}`,
  final,
});

describe("subtitle language search", () => {
  const options = ["ar", "tr", "es", "de"].map((tag) => languageOption(tag, "en"));

  it("finds a language by its own name, the viewer's name or a fragment, ignoring accents", () => {
    expect(searchLanguages(options, "turk").map((o) => o.tag)).toEqual(["tr"]);
    expect(searchLanguages(options, "espanol").map((o) => o.tag)).toEqual(["es"]);
    expect(searchLanguages(options, "العربية").map((o) => o.tag)).toEqual(["ar"]);
    expect(searchLanguages(options, "")).toHaveLength(4);
  });

  it("names each language in its own script and marks right-to-left ones", () => {
    expect(languageOption("tr", "en").autonym).toBe("Türkçe");
    expect(languageOption("ar", "en").dir).toBe("rtl");
  });
});

describe("subtitles on screen", () => {
  const lines = [line(0, 1_000), line(1, 5_500), line(2, 10_000)];

  it("rewound, shows the lines spoken around t and none from later", () => {
    expect(cuesAt(lines, 6_000, false, 1).map((l) => l.id)).toEqual(["1"]);
    expect(cuesAt(lines, 6_000, false, 2).map((l) => l.id)).toEqual(["0", "1"]);
    expect(cuesAt(lines, 30_000, false)).toEqual([]);
  });

  it("live, shows the newest line while it forms, even a moment ahead of the frame", () => {
    const forming = [...lines, line(3, 14_600, false)];
    expect(cuesAt(forming, 14_000, true, 1).map((l) => l.id)).toEqual(["3"]);
  });
});

describe("progress bar", () => {
  const chapters = [
    { id: 0, start_ms: 1_000, title: "Introduction", summary: "" },
    { id: 1, start_ms: 61_000, title: "Erosion", summary: "" },
  ];

  it("has one segment per chapter, the last open to the live edge", () => {
    const segs = chapterSegments(chapters, 0, 90_000);
    expect(segs.map((s) => [s.start, s.end, s.chapter?.title])).toEqual([
      [0, 1_000, undefined],
      [1_000, 61_000, "Introduction"],
      [61_000, 90_000, "Erosion"],
    ]);
    expect(chapterAt(chapters, 70_000)?.title).toBe("Erosion");
  });

  it("shows holes where nobody broadcast, but not the archive trailing live", () => {
    const holes = holesIn(
      [
        { start: 0, end: 10_000 },
        { start: 30_000, end: 50_000 },
      ],
      0,
      60_000,
    );
    expect(holes).toEqual([{ start: 10_000, end: 30_000 }]);
  });
});

describe("player states", () => {
  const base: PlayerStateInput = {
    connection: "connected",
    everConnected: true,
    onAir: true,
    mode: "live",
    liveEdge: 100_000,
    behindMs: 0,
  };

  it("says live, behind with the offset and a way back, or what went wrong", () => {
    expect(playerState(base).kind).toBe("live");
    const behind = playerState({ ...base, mode: "rewound", behindMs: 270_000 });
    expect([behind.kind, behind.pill, behind.canGoLive]).toEqual(["behind", "−4:30", true]);
    expect(playerState({ ...base, connection: "connecting" }).kind).toBe("reconnecting");
    expect(playerState({ ...base, connection: "connecting", everConnected: false }).kind).toBe("connecting");
    expect(playerState({ ...base, connection: "failed" }).card?.retry).toBe(true);
    expect(playerState({ ...base, onAir: false, liveEdge: undefined, room: "waiting" }).kind).toBe("not-started");
    expect(playerState({ ...base, onAir: false }).kind).toBe("ended");
    expect(playerState({ ...base, room: "paused" }).kind).toBe("paused");
  });

  it("tells an unknown room from one not started, a talk seen ending from a recording, and marks a looped room", () => {
    const nothing = { ...base, onAir: undefined, liveEdge: undefined };
    expect(playerState({ ...nothing, known: false }).kind).toBe("unknown");
    expect(playerState({ ...nothing, known: false }).card?.hub).toBe(true);
    // Silence is not "Not started": only the room service's waiting record says that (a created room has it).
    expect(playerState({ ...nothing, known: true }).kind).not.toBe("not-started");
    expect(playerState({ ...nothing }).kind).not.toBe("not-started");
    expect(playerState({ ...nothing, room: "waiting" }).kind).toBe("not-started");
    // A room the room service knows is waiting is never unknown.
    expect(playerState({ ...nothing, known: false, room: "waiting" }).kind).toBe("not-started");

    const seen = playerState({ ...base, onAir: false, sawLive: true });
    const later = playerState({ ...base, onAir: false });
    expect([seen.kind, later.kind]).toEqual(["ended", "ended"]);
    expect(seen.pill).not.toBe(later.pill);
    expect(seen.card?.replay && later.card?.replay).toBe(true);

    expect(playerState({ ...base, looped: true }).kind).toBe("live");
    expect(playerState({ ...base, looped: true }).pill).not.toBe(playerState(base).pill);
  });

  it("never ends a looped room; any other room ends by its room track's newest record", () => {
    expect(playerState({ ...base, looped: true, room: "ended" }).kind).toBe("live");
    expect(playerState({ ...base, looped: true, onAir: false }).kind).toBe("live");
    expect(playerState({ ...base, room: "ended" }).kind).toBe("ended");
    expect(playerState({ ...base, room: "on_air", onAir: false }).kind).toBe("live");
  });
});

describe("the camera tile without a picture", () => {
  it("claims no audio before the live player starts, and says audio without a picture only once it plays", () => {
    // Before play nothing runs: a live session's picture comes with the live player (seen on the VM, 11-02).
    expect(cameraNote(true, "idle")).toBeUndefined();
    expect(cameraNote(true, "loading")).toBeDefined();
    expect(cameraNote(true, "playing")).toBeDefined();
    expect(cameraNote(true, "playing")).not.toBe(cameraNote(true, "loading"));
    expect(cameraNote(false, "idle")).toBeDefined(); // rewound with no picture archived
  });
});

describe("subtitle position", () => {
  it("moves by fractions of the canvas and stays in the safe area", () => {
    const moved = dragSubtitle({ x: 0.5, y: 0.9 }, -0.2, -0.3);
    expect(moved.x).toBeCloseTo(0.3);
    expect(moved.y).toBeCloseTo(0.6);
    const clamped = dragSubtitle({ x: 0.5, y: 0.9 }, 2, 2);
    expect(clamped.x).toBeLessThan(1);
    expect(clamped.y).toBeLessThan(1);
  });
});

describe("preferences", () => {
  it("fall back to the defaults when storage is missing or broken", () => {
    expect(readPrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(
      readPrefs({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual(DEFAULT_PREFS);
    const saved = readPrefs({ getItem: () => JSON.stringify({ cc: true, style: { size: 30 } }) });
    expect([saved.cc, saved.style.size, saved.style.preset]).toEqual([true, 30, "default"]);
  });
});

describe("tracks the player subscribes", () => {
  const track = (id: string, kind: TrackView["kind"], lang?: string) => ({ id, kind, lang }) as TrackView;
  const room = roomTracks([
    track("captions/items", "captions", "en"),
    track("translate-ar/items", "translation", "ar"),
    track("chapters/outline", "outline"),
    track("describe/items", "slides"),
  ]);

  it("are none while nothing is picked or open (decisions 0010, 0026)", () => {
    expect([...wantedTracks(DEFAULT_PREFS, room, undefined)]).toEqual([]);
  });

  it("follow the subtitle language picked, the tab open and the sound chosen", () => {
    const on = (p: Partial<typeof DEFAULT_PREFS>, tab?: string) =>
      [...wantedTracks({ ...DEFAULT_PREFS, ...p }, room, tab)].sort();
    expect(on({ cc: true })).toEqual(["captions/items"]);
    expect(on({ cc: true, subtitleLang: "ar" })).toEqual(["translate-ar/items"]);
    expect(on({ cc: true, subtitleLang: "ar", dual: true })).toEqual(["captions/items", "translate-ar/items"]);
    expect(on({}, "transcript")).toEqual(["captions/items"]);
    expect(on({}, "chapters")).toEqual(["chapters/outline"]);
    expect(on({}, "glossary")).toEqual(["chapters/outline"]);
    expect(on({}, "descriptions")).toEqual(["describe/items"]);
    expect(on({}, "notes")).toEqual([]);
    expect(on({ sound: "describe" })).toEqual(["describe/items"]);
    // A panel tab counts only while the panel is open.
    expect(openTab({ panel: false, tab: "chapters" })).toBeUndefined();
  });

  it("stay subscribed for 30 s after nothing needs them, so a quick change back never unsubscribes", () => {
    const linger = new Linger(30_000);
    const ids = (s: Set<string>) => [...s].sort();
    expect(ids(linger.hold(new Set(["captions/items"]), 0).held)).toEqual(["captions/items"]);
    // Off: still held, and due to go at 30 s.
    const off = linger.hold(new Set(), 1_000);
    expect([ids(off.held), off.next]).toEqual([["captions/items"], 31_000]);
    // Arabic picked 10 s later: both held, the original until its 30 s are up.
    expect(ids(linger.hold(new Set(["translate-ar/items"]), 11_000).held)).toEqual([
      "captions/items",
      "translate-ar/items",
    ]);
    expect(ids(linger.hold(new Set(["translate-ar/items"]), 31_000).held)).toEqual(["translate-ar/items"]);
    // Back to Arabic within the window costs nothing: it was never let go.
    linger.hold(new Set(), 40_000);
    expect(ids(linger.hold(new Set(["translate-ar/items"]), 50_000).held)).toEqual(["translate-ar/items"]);
    expect(linger.hold(new Set(["translate-ar/items"]), 100_000).next).toBeUndefined();
  });
});

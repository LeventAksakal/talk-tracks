import { describe, expect, it } from "vitest";
import type { TrackView } from "../playback/aiTracks";
import type { LineItem } from "../playback/wire";
import { languageOption, searchLanguages } from "./languages";
import { DEFAULT_PREFS, readPrefs } from "./prefs";
import { playerState, type PlayerStateInput } from "./state";
import { cuesAt } from "./subtitles";
import { dragSubtitle } from "./SubtitleOverlay";
import { chapterAt, chapterSegments, holesIn } from "./timeline";
import { roomTracks, wantedTracks } from "./tracks";

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
    expect(playerState({ ...base, onAir: false, liveEdge: undefined }).kind).toBe("not-started");
    expect(playerState({ ...base, onAir: false }).kind).toBe("ended");
    expect(playerState({ ...base, room: "paused" }).kind).toBe("paused");
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

  it("are none until the viewer turns a feature on (decision 0010)", () => {
    expect([...wantedTracks(DEFAULT_PREFS, room)]).toEqual([]);
  });

  it("follow the subtitle language, dual subtitles and features", () => {
    const on = (p: Partial<typeof DEFAULT_PREFS>) => [...wantedTracks({ ...DEFAULT_PREFS, ...p }, room)].sort();
    expect(on({ cc: true })).toEqual(["captions/items"]);
    expect(on({ cc: true, subtitleLang: "ar" })).toEqual(["translate-ar/items"]);
    expect(on({ cc: true, subtitleLang: "ar", dual: true })).toEqual(["captions/items", "translate-ar/items"]);
    expect(on({ chapters: true, describe: "text" })).toEqual(["chapters/outline", "describe/items"]);
  });
});

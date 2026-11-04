import { describe, expect, it } from "vitest";
import { agentPath, ITEMS_TRACK } from "../contracts/names";
import type { RoomCatalog } from "../contracts/types";
import type { TrackView } from "../playback/aiTracks";
import { offeredLanguage, offeredTranslation } from "./LanguageOffer";
import { languageReadiness, roomSubtitles, roomTracks, translationFor, wantedTracks } from "./tracks";

const ROOM = "r1";
const NOW = 1_000_000;
const view = (agent: string, kind: TrackView["kind"], lang?: string): TrackView =>
  ({ id: `${agent}/items`, agent, track: ITEMS_TRACK, kind, lang, enabled: false }) as TrackView;
const room = roomTracks([
  view("captions", "captions"),
  view("translate-es", "translation", "es"),
  view("translate-tr", "translation", "tr"),
]);
const running = (agents: string[]): RoomCatalog => ({
  tracks: [],
  tt: {
    E: 0,
    shift: {},
    status: Object.fromEntries(
      agents.map((a) => [
        a,
        { status: "live", producing: true, fetches_served: 0, backfills: 0, spend_usd: 0, updated_ms: NOW },
      ]),
    ),
  },
});
const guard = (agents: string[]) => ({ catalog: running(agents), room: ROOM, offline: false, now: NOW });
const off = { cc: false, subtitleLang: "original" };

describe("the language offer", () => {
  it("offers the browser's language only when the room already runs it", () => {
    expect(offeredTranslation(room, off, "es-MX", guard(["translate-es"]), [])?.lang).toBe("es");
    // Turkish exists but nobody runs it: offering it would wake a paid agent.
    expect(offeredTranslation(room, off, "tr-TR", guard(["translate-es"]), [])).toBeUndefined();
    // No translation of that language at all, or the talk is in it already.
    expect(offeredTranslation(room, off, "de", guard(["translate-es"]), [])).toBeUndefined();
    expect(offeredTranslation(room, off, "en-GB", guard(["translate-es"]), [])).toBeUndefined();
    // A recorded (looped) room's tracks are free to read.
    const free: RoomCatalog = {
      ...running([]),
      tracks: [{ name: ITEMS_TRACK, namespace: agentPath(ROOM, "translate-tr"), packaging: "x", tt: { cost: "free" } }],
    };
    expect(offeredTranslation(room, off, "tr", { catalog: free, room: ROOM, offline: false, now: NOW }, [])?.lang).toBe(
      "tr",
    );
  });

  it("is not offered again once answered, or once the listener has picked subtitles", () => {
    expect(offeredTranslation(room, off, "es", guard(["translate-es"]), ["es"])).toBeUndefined();
    expect(
      offeredTranslation(room, { cc: true, subtitleLang: "tr" }, "es", guard(["translate-es"]), []),
    ).toBeUndefined();
  });
});

describe("the subtitles menu's languages", () => {
  const free: RoomCatalog = {
    ...running([]),
    tracks: [{ name: ITEMS_TRACK, namespace: agentPath(ROOM, "translate-tr"), packaging: "x", tt: { cost: "free" } }],
  };
  const es = translationFor(room, "es");
  const tr = translationFor(room, "tr");

  it("tells a language ready now (running or recorded) from one that starts on request, and one the room lacks", () => {
    expect(languageReadiness(es, guard(["translate-es"]))).toBe("running");
    // Listed by the room, but nobody runs it: picking it wakes its agent.
    expect(languageReadiness(tr, guard(["translate-es"]))).toBe("on-request");
    expect(languageReadiness(tr, { catalog: free, room: ROOM, offline: false, now: NOW })).toBe("recorded");
    expect(languageReadiness(translationFor(room, "de"), guard([]))).toBe("absent");
    // This listener's own subscription is running, whatever the catalog says.
    expect(languageReadiness({ ...tr!, enabled: true }, guard([]))).toBe("running");
  });

  it("takes the stats track's running list as running too (decision 0028)", () => {
    const stats = new Set([`${agentPath(ROOM, "translate-tr")}/${ITEMS_TRACK}`]);
    expect(languageReadiness(tr, guard([]), stats)).toBe("running");
    expect(languageReadiness(es, guard([]), stats)).toBe("on-request");
  });
});

describe("a subtitle language picked in another room", () => {
  const picked = { cc: true, subtitleLang: "tr", subtitleRoom: "elsewhere" };

  it("is not subscribed where it would wake a paid agent: the original shows and the language is offered", () => {
    const shown = roomSubtitles(picked, ROOM, room, guard([]));
    expect(shown.subtitleLang).toBe("original");
    expect(wantedTracks(shown, room, undefined)).toEqual(new Set(["captions/items"]));
    expect(offeredLanguage(room, shown, "tr", false, undefined, guard([]), [])?.lang).toBe("tr");
    // Answered on this page: not offered again.
    expect(offeredLanguage(room, shown, "tr", true, undefined, guard([]), [])).toBeUndefined();
  });

  it("carries over where it costs nothing more: running, or recorded", () => {
    expect(roomSubtitles(picked, ROOM, room, guard(["translate-tr"])).subtitleLang).toBe("tr");
    const free: RoomCatalog = {
      ...running([]),
      tracks: [{ name: ITEMS_TRACK, namespace: agentPath(ROOM, "translate-tr"), packaging: "x", tt: { cost: "free" } }],
    };
    const recorded = roomSubtitles(picked, ROOM, room, { catalog: free, room: ROOM, offline: false, now: NOW });
    expect(recorded.subtitleLang).toBe("tr");
  });

  it("stays picked in the room it was picked in, paid or not", () => {
    expect(roomSubtitles({ ...picked, subtitleRoom: ROOM }, ROOM, room, guard([])).subtitleLang).toBe("tr");
    // A language remembered from before picks were kept per room counts as picked elsewhere.
    expect(roomSubtitles({ cc: true, subtitleLang: "tr" }, ROOM, room, guard([])).subtitleLang).toBe("original");
  });
});

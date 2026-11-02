import { describe, expect, it } from "vitest";
import { agentPath, ITEMS_TRACK } from "../contracts/names";
import type { RoomCatalog } from "../contracts/types";
import type { TrackView } from "../playback/aiTracks";
import { offeredTranslation } from "./LanguageOffer";
import { roomTracks } from "./tracks";

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

import { useState } from "react";
import "./download.css";
import type { TrackView } from "../playback/aiTracks";
import { guardOf } from "../package/download";
import { type LanguageGuard, whyFree } from "../package/languages";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { languageOption } from "./languages";
import type { Prefs } from "./prefs";
import { type RoomTracks, translationFor } from "./tracks";

const KEY = "tt.languageOffer.v1";
const base = (tag: string) => tag.toLowerCase().split("-")[0]!;

/** Languages the listener has answered the offer for (taken or dismissed), kept in this browser. */
function answered(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Kept for this page only.
  }
}

function browserLanguage(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.languages?.[0] ?? navigator.language;
}

/**
 * The translation to offer a listener: the browser's language, when the talk is not already in it, the listener has
 * picked no subtitle language, it was never answered here, and the room runs it already (the cost guard: offering
 * a language nobody runs would wake a paid agent on a tap the listener did not expect to cost anything).
 */
export function offeredTranslation(
  room: RoomTracks,
  prefs: Pick<Prefs, "cc" | "subtitleLang">,
  browser: string | undefined,
  guard: LanguageGuard,
  done: readonly string[],
): TrackView | undefined {
  if (!browser || (prefs.cc && prefs.subtitleLang !== "original")) return undefined;
  if (base(browser) === base(room.captions?.lang ?? "en")) return undefined;
  const t = translationFor(room, browser);
  if (!t?.lang || done.includes(base(t.lang))) return undefined;
  return whyFree(t, guard) ? t : undefined;
}

/**
 * The language the listener picked in another room, which this room does not carry over because it would wake a
 * paid agent (tracks.roomSubtitles): offered until the listener answers it on this page. Then the browser's.
 */
export function offeredLanguage(
  room: RoomTracks,
  prefs: Pick<Prefs, "cc" | "subtitleLang">,
  carried: string | undefined,
  carriedAnswered: boolean,
  browser: string | undefined,
  guard: LanguageGuard,
  done: readonly string[],
): TrackView | undefined {
  const remembered = carried && !carriedAnswered ? translationFor(room, carried) : undefined;
  if (remembered?.lang && !(prefs.cc && prefs.subtitleLang !== "original")) return remembered;
  return offeredTranslation(room, prefs, browser, guard, done);
}

/**
 * One tap to subtitles in the language the listener picked in another room, or on a first visit in the browser's
 * language when the room is already translating into it. Nothing is subscribed until the listener taps.
 */
export function LanguageOffer() {
  const ctx = usePlayer();
  const { tracks, prefs, update, carried } = ctx;
  const [done, setDone] = useState(answered);
  const [carriedAnswered, setCarriedAnswered] = useState(false);
  const offer = offeredLanguage(tracks, prefs, carried, carriedAnswered, browserLanguage(), guardOf(ctx), done);
  if (!offer?.lang) return null;
  const lang = offer.lang;
  const name = languageOption(lang).autonym;
  const answer = () => {
    setCarriedAnswered(true);
    const next = [...done, base(lang)];
    remember(next);
    setDone(next);
  };
  return (
    <div className="tt-lang-offer" role="region" aria-label="Subtitles in your language">
      <span>
        Subtitles in <span lang={lang}>{name}</span>?
      </span>
      <button
        type="button"
        className="tt-button"
        onClick={() => {
          answer();
          update({ cc: true, subtitleLang: lang });
        }}
      >
        Turn on
      </button>
      <button type="button" className="tt-lang-offer-close" aria-label="No thanks" onClick={answer}>
        <Icon name="close" />
      </button>
    </div>
  );
}

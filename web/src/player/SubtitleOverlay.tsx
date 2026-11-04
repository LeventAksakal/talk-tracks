import { type CSSProperties, type RefObject, useState } from "react";
import type { TrackView } from "../playback/aiTracks";
import type { LineItem } from "../playback/wire";
import { dirOf } from "../viewer/lang";
import { usePlayer } from "./context";
import { useFrameValue } from "./frameClock";
import { languageOption } from "./languages";
import { type Fraction, type Prefs, type SourceKind } from "./prefs";
import { effectiveLayout, stageSources } from "./Stage";
import { cuesAt, subtitleTime } from "./subtitles";
import { translationFor } from "./tracks";

/** Where subtitles sit when the stage keeps no room for them under the main picture: bottom centre of the canvas. */
export const DEFAULT_SUBTITLE_POS: Fraction = { x: 0.5, y: 0.93 };

/** The corner tile's margin from the stage's edge, as a fraction of its width (player.css: about 16 px of 1000). */
const TILE_MARGIN = 0.02;

/**
 * Where the subtitles go when the stage keeps no room for them under the main picture, and how wide they may be:
 * bottom centre, or, with the corner tile in the bottom half of the stage, centred in the room left of it (or right of
 * it) so they never cover the camera.
 */
export function subtitlePlace(
  prefs: Pick<Prefs, "layout" | "board" | "pipPos" | "pipWidth">,
  sources: readonly SourceKind[],
): { pos: Fraction; maxWidth: number | undefined } {
  const placed = stageSources(sources, prefs.board);
  if (effectiveLayout(prefs.layout, placed) !== "pip" || placed.length < 2)
    return { pos: DEFAULT_SUBTITLE_POS, maxWidth: undefined };
  const left = prefs.pipPos?.x ?? 1 - prefs.pipWidth - TILE_MARGIN;
  const bottomHalf = prefs.pipPos === undefined || prefs.pipPos.y > 0.4;
  if (!bottomHalf) return { pos: DEFAULT_SUBTITLE_POS, maxWidth: undefined };
  const right = left + prefs.pipWidth;
  // The wider side of the tile takes the subtitles.
  const [from, to] = left >= 1 - right ? [TILE_MARGIN, left - TILE_MARGIN] : [right + TILE_MARGIN, 1 - TILE_MARGIN];
  return { pos: { x: (from + to) / 2, y: DEFAULT_SUBTITLE_POS.y }, maxWidth: Math.max(0.2, to - from) };
}

interface Shown {
  original: LineItem[];
  translation: LineItem[];
}

const sameLines = (a: LineItem[], b: LineItem[]) =>
  a.length === b.length && a.every((l, i) => l.id === b[i]!.id && l.text === b[i]!.text && l.final === b[i]!.final);
const sameShown = (a: Shown, b: Shown) => sameLines(a.original, b.original) && sameLines(a.translation, b.translation);

/**
 * The subtitles (ui-design §4.1, §4.2; decision 0020): DOM text with `lang` and `dir` per block, on the room time of
 * the frame on screen. They sit in one place under the speaker's content and never move with the pointer (owner QA,
 * 11-04): no drag, no hover, and the pointer passes through them to the stage.
 */
export function SubtitleOverlay({
  below,
}: {
  /** Kept for the stage's call; the subtitles no longer read the stage's box. */
  stageRef?: RefObject<HTMLDivElement | null>;
  /** Where the stage keeps room for the subtitles, under the main picture (stageFit), in px. */
  below?: { x: number; top: number; maxWidth: number };
}) {
  const { tracks, prefs, clock, view, sources, ui } = usePlayer();
  const live = view.timeline.mode === "live";
  const translating = prefs.subtitleLang !== "original";
  const trackFor = (lang: string) => (lang === "original" ? tracks.captions : translationFor(tracks, lang));
  const translation = translating ? translationFor(tracks, prefs.subtitleLang) : undefined;
  const primary = trackFor(prefs.subtitleLang);
  // A track has landed once it has something to show here: a live line, or the slice at the playhead.
  const landed = (t: TrackView | undefined) =>
    !!t?.enabled && (live ? t.lastLiveAt !== undefined : t.sliced?.loaded === true);
  // Switching language keeps the old line up until the new one lands (decision 0026); the old track lingers
  // subscribed for that (tracks.ts).
  const [stand, setStand] = useState<string>();
  const landedNow = prefs.cc && landed(primary);
  if (landedNow && stand !== prefs.subtitleLang) setStand(prefs.subtitleLang);
  const standIn =
    prefs.cc && !landedNow && stand !== undefined && stand !== prefs.subtitleLang && trackFor(stand)?.enabled
      ? stand
      : undefined;
  const showOriginal = prefs.cc && !standIn && !translating;
  const original = showOriginal && tracks.captions?.enabled ? (tracks.captions.sliced?.lines ?? []) : [];
  const shownTrack = standIn ? trackFor(standIn) : translation;
  const translated = prefs.cc && shownTrack?.enabled ? (shownTrack.sliced?.lines ?? []) : [];
  const max = prefs.style.lines;
  // Paused live, the subtitles hold at the moment of the pause: a live room's edge runs on behind a pause, and lines
  // must neither advance nor expire until play (owner QA, 11-04). Paused rewound, the frame clock itself holds and
  // follows a seek, so the subtitles read it: a seek while paused never leaves the old position's lines up.
  const [heldAt, setHeldAt] = useState<{ t: number | undefined; live: boolean }>();
  if (!ui.playing && heldAt?.live !== live) setHeldAt({ t: clock.now(), live });
  if (ui.playing && heldAt) setHeldAt(undefined);
  const shown = useFrameValue(
    clock,
    (now): Shown => {
      const t = subtitleTime(now, heldAt);
      // Paused rewound with no playhead yet (the archive opening after a seek): no line rather than any held one.
      if (heldAt && !heldAt.live && t === undefined) return { original: [], translation: [] };
      return {
        original: cuesAt(original, t, live, translating ? 1 : max).filter((l) => l.final || prefs.style.interim),
        translation: cuesAt(translated, t, live, max).filter((l) => l.final || prefs.style.interim),
      };
    },
    sameShown,
  );

  const place = subtitlePlace(prefs, sources);
  const pos = place.pos;

  const empty = shown.original.length === 0 && shown.translation.length === 0;
  const starting = standIn
    ? `${languageName(prefs.subtitleLang)} is starting · ${languageName(standIn)} stays up until it lands`
    : undefined;
  const status = prefs.cc && empty ? subtitleStatus() : undefined;
  if (!prefs.cc) return null;
  if (empty && !status) return null;

  function languageName(lang: string): string {
    if (lang !== "original") return languageOption(lang).autonym;
    return `The original (${languageOption(tracks.captions?.lang ?? "en").autonym})`;
  }

  function subtitleStatus(): string | undefined {
    if (starting) return starting;
    if (translating && !translation)
      return `${languageOption(prefs.subtitleLang).local} subtitles are not offered in this room yet.`;
    const track = translating ? translation : tracks.captions;
    if (!track) return "This room has no subtitles yet.";
    if (!track.enabled) return undefined;
    if (track.sliced?.capped) return "Subtitles are unavailable right now.";
    // Paused, nothing loads until play: no "Loading" promise while it waits.
    if (!live && track.sliced && !track.sliced.loaded && ui.playing)
      return translating ? "Translating earlier part…" : "Loading subtitles…";
    if (live && track.lastLiveAt === undefined) return "Subtitles start when the speaker speaks.";
    return undefined;
  }

  // They hang from the top of the room the stage keeps for them under the main picture, so they never cover it;
  // with no such room, at the bottom centre of the canvas.
  const hang = below;
  const style = {
    ...(hang
      ? { left: `${hang.x}px`, top: `${hang.top}px`, maxWidth: `${hang.maxWidth}px` }
      : {
          left: `${pos.x * 100}%`,
          top: `${pos.y * 100}%`,
          ...(place.maxWidth !== undefined ? { maxWidth: `calc(${place.maxWidth * 100}% - 8px)` } : {}),
        }),
    "--sub-size": `${prefs.style.size}px`,
    "--sub-bg": prefs.style.background,
  } as CSSProperties;
  const origLang = tracks.captions?.lang ?? "en";
  const transLang = shownTrack?.lang ?? prefs.subtitleLang;

  return (
    <div
      className="tt-subs"
      data-preset={prefs.style.preset}
      data-below={hang ? "" : undefined}
      style={style}
      aria-label="Subtitles"
    >
      {shown.original.map((l) => (
        <span
          key={`o${l.id}`}
          className={`tt-sub-line${translating ? " tt-sub-small" : ""}${l.final ? "" : " tt-sub-interim"}`}
          lang={origLang}
          dir={dirOf(origLang)}
        >
          {l.text}
        </span>
      ))}
      {shown.translation.map((l) => (
        <span
          key={`t${l.id}`}
          className={`tt-sub-line${l.final ? "" : " tt-sub-interim"}`}
          lang={transLang}
          dir={dirOf(transLang)}
        >
          {l.text}
        </span>
      ))}
      {empty && status ? <span className="tt-sub-status">{status}</span> : null}
      {!empty && starting ? <span className="tt-sub-status">{starting}</span> : null}
    </div>
  );
}

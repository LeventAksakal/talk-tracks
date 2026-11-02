import { type CSSProperties, type PointerEvent, type RefObject, useRef, useState } from "react";
import type { TrackView } from "../playback/aiTracks";
import type { LineItem } from "../playback/wire";
import { dirOf } from "../viewer/lang";
import { usePlayer } from "./context";
import { useFrameValue } from "./frameClock";
import { languageOption } from "./languages";
import { clamp, type Fraction, type Prefs, type SourceKind } from "./prefs";
import { effectiveLayout, stageSources } from "./Stage";
import { cuesAt } from "./subtitles";
import { translationFor } from "./tracks";

/** Where subtitles sit until moved: bottom centre of the canvas. */
export const DEFAULT_SUBTITLE_POS: Fraction = { x: 0.5, y: 0.93 };

/** The safe area the subtitles' bottom centre stays in, as fractions of the canvas. */
const SAFE = { x: [0.12, 0.88], y: [0.16, 0.97] } as const;

/** A dragged position: `from` moved by a fraction of the canvas, kept in the safe area. */
export function dragSubtitle(from: Fraction, dx: number, dy: number): Fraction {
  return { x: clamp(from.x + dx, SAFE.x[0], SAFE.x[1]), y: clamp(from.y + dy, SAFE.y[0], SAFE.y[1]) };
}

/** The corner tile's margin from the stage's edge, as a fraction of its width (player.css: about 16 px of 1000). */
const TILE_MARGIN = 0.02;

/**
 * Where the subtitles go when the viewer has not moved them, and how wide they may be: bottom centre, or, with the
 * corner tile in the bottom half of the stage, centred in the room left of it (or right of it) so they never cover
 * the camera.
 */
export function subtitlePlace(
  prefs: Pick<Prefs, "layout" | "board" | "pipPos" | "pipWidth" | "subtitlePos">,
  sources: readonly SourceKind[],
): { pos: Fraction; maxWidth: number | undefined } {
  if (prefs.subtitlePos) return { pos: prefs.subtitlePos, maxWidth: undefined };
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
 * The subtitles (ui-design §4.1, §4.2; decision 0020): DOM text with `lang` and `dir` per block, on the
 * room time of the frame on screen, dragged anywhere with Pointer Events and remembered as fractions of the
 * canvas, so they keep their place through resizes and layout changes.
 */
export function SubtitleOverlay({ stageRef }: { stageRef: RefObject<HTMLDivElement | null> }) {
  const { tracks, prefs, update, clock, view, sources } = usePlayer();
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
  const showOriginal = prefs.cc && !standIn && (!translating || prefs.dual);
  const original = showOriginal && tracks.captions?.enabled ? (tracks.captions.sliced?.lines ?? []) : [];
  const shownTrack = standIn ? trackFor(standIn) : translation;
  const translated = prefs.cc && shownTrack?.enabled ? (shownTrack.sliced?.lines ?? []) : [];
  const max = prefs.style.lines;
  const shown = useFrameValue(
    clock,
    (t): Shown => ({
      original: cuesAt(original, t, live, translating ? 1 : max).filter((l) => l.final || prefs.style.interim),
      translation: cuesAt(translated, t, live, max).filter((l) => l.final || prefs.style.interim),
    }),
    sameShown,
  );

  const place = subtitlePlace(prefs, sources);
  const pos = place.pos;
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; from: Fraction; to: Fraction } | undefined>(undefined);

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
    if (!live && track.sliced && !track.sliced.loaded)
      return translating ? "Translating earlier part…" : "Loading subtitles…";
    if (live && track.lastLiveAt === undefined) return "Subtitles start when the speaker speaks.";
    return undefined;
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !box.current) return;
    box.current.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: pos, to: pos };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!d || d.id !== e.pointerId || !rect || rect.width === 0 || rect.height === 0 || !box.current) return;
    d.to = dragSubtitle(d.from, (e.clientX - d.x) / rect.width, (e.clientY - d.y) / rect.height);
    // Moved directly while dragging; saved (and re-rendered) once on release.
    box.current.style.left = `${d.to.x * 100}%`;
    box.current.style.top = `${d.to.y * 100}%`;
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = undefined;
    if (d && (d.to.x !== d.from.x || d.to.y !== d.from.y)) update({ subtitlePos: d.to });
  };

  const style = {
    left: `${pos.x * 100}%`,
    top: `${pos.y * 100}%`,
    "--sub-size": `${prefs.style.size}px`,
    "--sub-bg": prefs.style.background,
    ...(place.maxWidth !== undefined ? { maxWidth: `calc(${place.maxWidth * 100}% - 8px)` } : {}),
  } as CSSProperties;
  const origLang = tracks.captions?.lang ?? "en";
  const transLang = shownTrack?.lang ?? prefs.subtitleLang;

  return (
    <div
      ref={box}
      className="tt-subs"
      data-preset={prefs.style.preset}
      data-placed={prefs.subtitlePos ? "" : undefined}
      style={style}
      title="Drag to move the subtitles"
      aria-label="Subtitles"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <span className="tt-subs-grip" aria-hidden="true" />
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

import { type CSSProperties, type PointerEvent, type RefObject, useRef } from "react";
import type { LineItem } from "../playback/wire";
import { dirOf } from "../viewer/lang";
import { usePlayer } from "./context";
import { useFrameValue } from "./frameClock";
import { languageOption } from "./languages";
import { clamp, type Fraction } from "./prefs";
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
  const { tracks, prefs, update, clock, view, ui } = usePlayer();
  const live = view.timeline.mode === "live";
  const translating = prefs.subtitleLang !== "original";
  const translation = translating ? translationFor(tracks, prefs.subtitleLang) : undefined;
  const showOriginal = prefs.cc && (!translating || prefs.dual);
  const original = showOriginal && tracks.captions?.enabled ? (tracks.captions.sliced?.lines ?? []) : [];
  const translated = prefs.cc && translation?.enabled ? (translation.sliced?.lines ?? []) : [];
  const max = prefs.style.lines;
  const shown = useFrameValue(
    clock,
    (t): Shown => ({
      original: cuesAt(original, t, live, translating ? 1 : max).filter((l) => l.final || prefs.style.interim),
      translation: cuesAt(translated, t, live, max).filter((l) => l.final || prefs.style.interim),
    }),
    sameShown,
  );

  const pos = prefs.subtitlePos ?? DEFAULT_SUBTITLE_POS;
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; from: Fraction; to: Fraction } | undefined>(undefined);

  const preview = ui.menu === "style";
  const empty = shown.original.length === 0 && shown.translation.length === 0;
  const status = prefs.cc && empty ? subtitleStatus() : undefined;
  if (!prefs.cc && !preview) return null;
  if (empty && !status && !preview) return null;

  function subtitleStatus(): string | undefined {
    if (translating && !translation)
      return `${languageOption(prefs.subtitleLang).local} subtitles are not offered in this room yet.`;
    const track = translating ? translation : tracks.captions;
    if (!track) return "This room has no subtitles yet.";
    if (!track.enabled) return undefined;
    if (track.sliced?.capped) return "Subtitles paused: the room's budget is reached.";
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
  } as CSSProperties;
  const origLang = tracks.captions?.lang ?? "en";
  const transLang = translation?.lang ?? prefs.subtitleLang;

  return (
    <div
      ref={box}
      className="tt-subs"
      data-preset={prefs.style.preset}
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
      {empty && !status && preview ? (
        <span className="tt-sub-line">Subtitles look like this while you adjust them.</span>
      ) : null}
    </div>
  );
}

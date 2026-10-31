import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { usePlayer } from "./context";
import { clamp } from "./prefs";
import { chapterAt, chapterSegments, formatBehind, holesIn } from "./timeline";
import { fold } from "./languages";

const noop = () => () => {};
const zero = () => 0;

/**
 * The progress bar (ui-design §4.3, §4.5): one segment per chapter with small gaps (YouTube's pattern), the
 * played part, archived media, holes where nobody broadcast, marks for slide changes, bookmarks and transcript
 * search matches, and a preview above the pointer with the time, the chapter and the slide. Drag anywhere in
 * the room's history; the keyboard moves it too.
 */
export function ProgressBar() {
  const { view, tracks, notes, ui, at, talkClock, seek, goLive, state, slides: slideTracks, slidesShown } = usePlayer();
  // Thumbnails come from the slide track and the deck while the slides are on (decision 0010).
  const deck = slidesShown ? slideTracks : undefined;
  useSyncExternalStore(deck?.subscribe ?? noop, deck?.getVersion ?? zero);
  const t = view.timeline;
  const end = t.liveEdge ?? t.position ?? 0;
  const start = Math.min(t.start, end);
  const span = Math.max(1, end - start);
  const ready = t.liveEdge !== undefined && state.kind !== "connecting" && state.kind !== "not-started";
  const chapters = tracks.outline?.enabled ? (tracks.outline.outline?.chapters ?? []) : [];
  const segments = chapterSegments(chapters, start, end);
  const [hover, setHover] = useState<number>();
  const [scrub, setScrub] = useState<number>();
  const track = useRef<HTMLDivElement>(null);
  const shownAt = scrub ?? (t.mode === "live" ? end : (at ?? end));
  const frac = (ms: number) => clamp((ms - start) / span, 0, 1);

  const msAt = (clientX: number): number | undefined => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return undefined;
    return start + clamp((clientX - rect.left) / rect.width, 0, 1) * span;
  };
  const commit = (ms: number) => (end - ms < 1_000 ? goLive() : seek(ms));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!ready || e.button !== 0) return;
    const ms = msAt(e.clientX);
    if (ms === undefined) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrub(ms);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const ms = msAt(e.clientX);
    if (ms === undefined) return;
    setHover(ms);
    if (scrub !== undefined) setScrub(ms);
  };
  const onPointerUp = () => {
    if (scrub !== undefined) commit(scrub);
    setScrub(undefined);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!ready) return;
    const step: Record<string, number> = { ArrowLeft: -5_000, ArrowRight: 5_000, PageDown: -60_000, PageUp: 60_000 };
    if (e.key in step) commit(clamp(shownAt + step[e.key]!, start, end));
    else if (e.key === "Home") seek(start);
    else if (e.key === "End") goLive();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // Marks: slide changes, bookmarks and notes, transcript search matches.
  const slides = tracks.describe?.enabled ? (tracks.describe.sliced?.slides ?? []) : [];
  const query = fold(ui.search.trim());
  const matches =
    query.length >= 2 && tracks.captions?.enabled
      ? (tracks.captions.sliced?.lines ?? []).filter((l) => fold(l.text).includes(query))
      : [];
  const inSpan = (ms: number) => ms >= start && ms <= end;
  const preview = scrub ?? hover;
  const previewChapter = chapterAt(chapters, preview);
  const previewSlide = preview === undefined ? undefined : slides.findLast((s) => s.atMs <= preview);
  const previewShown = preview !== undefined && deck ? deck.previewAt(preview) : undefined;
  const thumb = previewShown && deck ? deck.picture(previewShown.deck, previewShown.index) : undefined;
  const valueText = state.recording
    ? `${talkClock(shownAt)} of ${talkClock(end)}, recorded`
    : t.mode === "live"
      ? `${talkClock(end)}, live`
      : `${talkClock(shownAt)}, ${formatBehind(end - shownAt)} behind live`;

  return (
    <div
      className={`tt-progress${scrub !== undefined ? " tt-scrubbing" : ""}${ready ? "" : " tt-disabled"}`}
      role="slider"
      tabIndex={ready ? 0 : -1}
      aria-label="Position in the talk"
      aria-valuemin={Math.round(start / 1000)}
      aria-valuemax={Math.round(end / 1000)}
      aria-valuenow={Math.round(shownAt / 1000)}
      aria-valuetext={valueText}
      aria-disabled={!ready}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setScrub(undefined)}
      onPointerLeave={() => setHover(undefined)}
      onKeyDown={onKeyDown}
    >
      <div className="tt-progress-track" ref={track}>
        {segments.map((s) => {
          const fill = clamp((shownAt - s.start) / Math.max(1, s.end - s.start), 0, 1);
          const hot = preview !== undefined && preview >= s.start && preview < s.end && segments.length > 1;
          return (
            <div
              key={s.start}
              className={`tt-seg${hot ? " tt-hot" : ""}`}
              style={{ flexGrow: s.end - s.start } as CSSProperties}
            >
              <div className="tt-seg-fill" style={{ width: `${fill * 100}%` }} />
            </div>
          );
        })}
        {holesIn(t.available, start, end).map((h) => (
          <span
            key={`h${h.start}`}
            className="tt-hole"
            style={{ left: `${frac(h.start) * 100}%`, width: `${(frac(h.end) - frac(h.start)) * 100}%` }}
          />
        ))}
        {slides
          .filter((s) => inSpan(s.atMs))
          .map((s) => (
            <span key={`s${s.id}`} className="tt-mark tt-mark-slide" style={{ left: `${frac(s.atMs) * 100}%` }} />
          ))}
        {notes.notes
          .filter((n) => inSpan(n.at))
          .map((n) => (
            <span key={`n${n.id}`} className="tt-mark tt-mark-note" style={{ left: `${frac(n.at) * 100}%` }} />
          ))}
        {matches
          .filter((l) => inSpan(l.startMs))
          .map((l) => (
            <span key={`m${l.id}`} className="tt-mark tt-mark-match" style={{ left: `${frac(l.startMs) * 100}%` }} />
          ))}
        {ready ? <span className="tt-head" style={{ left: `${frac(shownAt) * 100}%` }} /> : null}
        {preview !== undefined && ready ? (
          <div className="tt-preview" style={{ "--x": `${frac(preview) * 100}%` } as CSSProperties} aria-hidden="true">
            <div className="tt-preview-thumb">
              {thumb ? (
                <img src={thumb.url} alt="" data-slide={thumb.image.index + 1} />
              ) : previewShown ? (
                <span>Slide {previewShown.index + 1}</span>
              ) : previewSlide ? (
                <span>Slide {previewSlide.id + 1}</span>
              ) : (
                <span className="tt-preview-blank" />
              )}
            </div>
            <span className="tt-preview-time">{talkClock(preview)}</span>
            {previewChapter ? <span className="tt-preview-chapter">{previewChapter.title}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

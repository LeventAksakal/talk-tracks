import { type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject, useRef } from "react";
import { formatClock } from "../playback/timeline";
import { CameraSurface } from "./CameraSurface";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { clamp, type Fraction, type LayoutKind, type SourceKind } from "./prefs";
import { SlideSurface } from "./SlideSurface";
import { StatsForNerds } from "./StatsForNerds";
import { SubtitleOverlay } from "./SubtitleOverlay";

/** Default corner of the picture-in-picture window (top-left, fractions of the canvas). */
const PIP_DEFAULT: Fraction = { x: 0.71, y: 0.68 };
const PIP_WIDTH = 0.27;

/** The layout actually shown: one source means single, whatever the preference. */
export function effectiveLayout(layout: LayoutKind, sources: readonly SourceKind[]): LayoutKind {
  return sources.length < 2 ? "single" : layout;
}

/**
 * The canvas (ui-design §3.1–§3.2): the sources in the chosen layout (single, split with a draggable divider,
 * picture-in-picture with a draggable window, swap), and over them the subtitles, "What you missed", Stats for
 * nerds and the state cards of §5. Both source tiles stay mounted in one place in every layout (CSS moves
 * them), so the live canvas is never re-created.
 */
export function Stage() {
  const { prefs, update, sources, ui, setUi, state, view, playback, media, togglePlay, openTab } = usePlayer();
  const stage = useRef<HTMLDivElement>(null);
  const layout = effectiveLayout(prefs.layout, sources);
  const hasCamera = sources.includes("camera");
  const hasSlides = sources.includes("slides");
  // Which source is "first": the left one in split, the small one in picture-in-picture.
  const first: SourceKind = prefs.swap ? "slides" : "camera";
  const shown = (kind: SourceKind) =>
    sources.includes(kind) && (layout !== "single" || (sources.length < 2 ? true : prefs.single === kind));
  const role = (kind: SourceKind) =>
    layout === "pip" ? (kind === first ? "small" : "main") : layout === "split" ? (kind === first ? "a" : "b") : "main";

  const pip = prefs.pipPos ?? PIP_DEFAULT;
  const style = { "--split": prefs.split, "--pip-x": pip.x, "--pip-y": pip.y, "--pip-w": PIP_WIDTH } as CSSProperties;
  const card = state.card;
  const needsGesture = media !== undefined && !ui.playing && view.timeline.mode === "live" && !card;

  return (
    <div
      ref={stage}
      className={`tt-stage tt-layout-${layout}${prefs.swap ? " tt-swapped" : ""}${card?.dim ? " tt-dimmed" : ""}`}
      style={style}
      onContextMenu={(e) => {
        e.preventDefault();
        setUi((u) => ({ stats: !u.stats, menu: undefined }));
      }}
    >
      {hasCamera ? (
        <div className={`tt-cell tt-cell-camera tt-cell-${role("camera")}${shown("camera") ? "" : " tt-hidden"}`}>
          {layout === "pip" && role("camera") === "small" ? <PipHandle stageRef={stage} /> : null}
          <CameraSurface />
        </div>
      ) : null}
      {layout === "split" ? <SplitDivider stageRef={stage} /> : null}
      {hasSlides ? (
        <div className={`tt-cell tt-cell-slides tt-cell-${role("slides")}${shown("slides") ? "" : " tt-hidden"}`}>
          {layout === "pip" && role("slides") === "small" ? <PipHandle stageRef={stage} /> : null}
          <SlideSurface />
        </div>
      ) : null}

      <SubtitleOverlay stageRef={stage} />

      {view.missed && !card ? (
        <div className="tt-missed" role="status">
          <span>
            You missed {formatClock(view.missed.toMs - view.missed.fromMs)}
            {view.missed.outlineOn
              ? ` · ${view.missed.chapters.length} chapter${view.missed.chapters.length === 1 ? "" : "s"}`
              : ""}
          </span>
          <button
            type="button"
            className="tt-link"
            onClick={() => {
              update({ chapters: true });
              openTab("chapters");
              playback.dismissMissed();
            }}
          >
            Show
          </button>
          <button
            type="button"
            className="tt-link"
            onClick={() => {
              update({ transcript: true });
              openTab("transcript");
              playback.dismissMissed();
            }}
          >
            Transcript
          </button>
          <button
            type="button"
            className="tt-icon-button tt-small"
            aria-label="Dismiss"
            onClick={() => playback.dismissMissed()}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}

      {ui.stats ? <StatsForNerds /> : null}

      {needsGesture ? (
        <button type="button" className="tt-big-play" onClick={togglePlay}>
          <Icon name="play" />
          <span>Play the talk</span>
        </button>
      ) : null}

      {card ? (
        <div className="tt-state-card" role="status">
          <strong>{card.title}</strong>
          {card.body ? <span>{card.body}</span> : null}
          {card.retry ? (
            <button type="button" className="tt-button" onClick={() => location.reload()}>
              Try again
            </button>
          ) : null}
          {card.replay ? (
            <button type="button" className="tt-button" onClick={() => playback.seek(view.timeline.start)}>
              Replay from the start
            </button>
          ) : null}
        </div>
      ) : null}

      {ui.toast ? (
        <div className="tt-toast" aria-hidden="true">
          {ui.toast}
        </div>
      ) : null}
    </div>
  );
}

/** The split divider: drag, or arrow keys when focused, to move it. */
function SplitDivider({ stageRef }: { stageRef: RefObject<HTMLDivElement | null> }) {
  const { prefs, update } = usePlayer();
  const dragging = useRef(false);
  const set = (v: number) => update({ split: clamp(v, 0.2, 0.8) });
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!dragging.current || !rect || rect.width === 0) return;
    const f = (e.clientX - rect.left) / rect.width;
    // Swapped, the slides are on the left and the share is still the camera's.
    set(prefs.swap ? 1 - f : f);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? -0.05 : e.key === "ArrowRight" ? 0.05 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    set(prefs.split + (prefs.swap ? -step : step));
  };
  return (
    <div
      className="tt-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the camera and slides"
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(prefs.split * 100)}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={onMove}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    />
  );
}

/** Drag the picture-in-picture window anywhere on the canvas; it is kept inside. */
function PipHandle({ stageRef }: { stageRef: RefObject<HTMLDivElement | null> }) {
  const { prefs, update } = usePlayer();
  const drag = useRef<{ x: number; y: number; from: Fraction } | undefined>(undefined);
  const from = prefs.pipPos ?? PIP_DEFAULT;
  return (
    <div
      className="tt-pip-handle"
      title="Drag to move"
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, from };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const rect = stageRef.current?.getBoundingClientRect();
        if (!d || !rect || rect.width === 0 || rect.height === 0) return;
        const smallH = (PIP_WIDTH * rect.width * 9) / 16 / rect.height;
        update({
          pipPos: {
            x: clamp(d.from.x + (e.clientX - d.x) / rect.width, 0, 1 - PIP_WIDTH),
            y: clamp(d.from.y + (e.clientY - d.y) / rect.height, 0, Math.max(0, 1 - smallH)),
          },
        });
      }}
      onPointerUp={() => (drag.current = undefined)}
      onPointerCancel={() => (drag.current = undefined)}
    />
  );
}

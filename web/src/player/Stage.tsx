import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatClock } from "../playback/timeline";
import { Link } from "../router";
import { CameraSurface, useOffLayout } from "./CameraSurface";
import { ChatTab } from "./Chat";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import type { BoardKind, LayoutKind, Prefs, SourceKind } from "./prefs";
import { ScreenSurface } from "./ScreenSurface";
import { ChaptersPanel, TranscriptPanel } from "./SidePanel";
import { SlideSurface } from "./SlideSurface";
import { TileAspects } from "./SourceTile";
import { StatsForNerds } from "./StatsForNerds";
import { SubtitleOverlay } from "./SubtitleOverlay";
import { Workspace } from "./workspace/Workspace";

/** A click on a picture waits this long for a second one (a double-click is full screen, not play and pause). */
const DOUBLE_CLICK_MS = 250;

// The stage's older layout model (one picture, side by side, a corner tile), still read by the subtitles' default
// place and the source tests. The workspace (workspace/layout.ts) decides what is on screen now.

/** The layout actually shown: one source means single, whatever the preference. */
export function effectiveLayout(layout: LayoutKind, sources: readonly SourceKind[]): LayoutKind {
  return sources.length < 2 ? "single" : layout;
}

/**
 * The main picture: the slides, or a shared screen while there is one. With both, the listener's pick (`board`, the
 * screen unless they picked the slides); with one, that one.
 */
export function mainPicture(sources: readonly SourceKind[], board: BoardKind = "screen"): BoardKind | undefined {
  const other: BoardKind = board === "screen" ? "slides" : "screen";
  return sources.includes(board) ? board : sources.includes(other) ? other : undefined;
}

/**
 * The pictures the stage lays out, the corner one first: the camera (or, with no camera, the board source that is not
 * the main picture), and the main picture.
 */
export function stageSources(sources: readonly SourceKind[], board?: BoardKind): SourceKind[] {
  const main = mainPicture(sources, board);
  const out: SourceKind[] = [];
  if (sources.includes("camera")) out.push("camera");
  else if (main) {
    const other: BoardKind = main === "screen" ? "slides" : "screen";
    if (sources.includes(other)) out.push(other);
  }
  if (main) out.push(main);
  return out;
}

/**
 * Whether the camera's whole picture is the talk: a composed lecture video off its layout (a stage shot, a title
 * card, a zoom on a slide) is one picture, shown whole rather than cropped to the speaker. A shared screen keeps its
 * place.
 */
export function wholePicture(offLayout: boolean, sources: readonly SourceKind[]): boolean {
  return offLayout && sources.includes("camera") && !sources.includes("screen");
}

/**
 * Whether the camera has the stage to itself because there is no slide to show: the room has slides and a camera and
 * no shared screen, and at this moment the speaker shows no slide (and no description stands in for one).
 */
export function cameraAlone(noSlide: boolean, sources: readonly SourceKind[]): boolean {
  return noSlide && sources.includes("camera") && sources.includes("slides") && !sources.includes("screen");
}

/** Whether a source is on screen in the older layout model: present, and in the layout (single shows the one chosen). */
export function sourceShown(
  kind: SourceKind,
  prefs: Pick<Prefs, "layout" | "single" | "board">,
  sources: readonly SourceKind[],
  offLayout = false,
  noSlide = false,
): boolean {
  if (wholePicture(offLayout, sources) || cameraAlone(noSlide, sources)) return kind === "camera";
  const placed = stageSources(sources, prefs.board);
  if (!placed.includes(kind)) return false;
  if (effectiveLayout(prefs.layout, placed) !== "single" || placed.length < 2) return true;
  // "single" names the camera or the main picture, slides or screen.
  const main = placed.at(-1);
  return prefs.single === "camera" && placed.includes("camera") ? kind === "camera" : kind === main;
}

/**
 * The canvas (owner QA 2026-11-04): a workspace of panels the viewer arranges (workspace/Workspace.tsx). The slides,
 * the camera and a shared screen are pictures; Chat, Transcript, Chapters and Discussion are panels beside them; each
 * can be docked, tabbed, split or floated. Over the main picture the subtitles and "What you missed"; over the whole
 * canvas Stats for nerds and the state cards of §5. A click on a picture plays or pauses, a double-click is full
 * screen.
 */
export function Stage({ onToggle, onFullscreen }: { onToggle: () => void; onFullscreen: () => void }) {
  const {
    sources,
    sourcesPending,
    ui,
    setUi,
    state,
    view,
    playback,
    media,
    openTab,
    seek,
    listening,
    workspace,
    extraTabs,
  } = usePlayer();
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const overlayRef = useRef<HTMLDivElement>(null);
  // The pictures tell their shapes (SourceTile), so a floating window takes the picture's own shape.
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const report = useCallback((kind: string, aspect: number) => {
    setAspects((a) => (Math.abs((a[kind] ?? 0) - aspect) < 1e-3 ? a : { ...a, [kind]: aspect }));
  }, []);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  // Click plays or pauses, double-click is full screen (any streaming player), on a picture only: a panel to read or
  // type in is not the talk. A click on something of the picture's own (a button, the subtitles, the annotation
  // tools, a card) is that thing's; while drawing, the slide is the drawing surface.
  const annotating = listening?.get().annotating ?? false;
  const own = (e: MouseEvent) => {
    const t = e.target as Element;
    if (annotating || !t.closest?.(".tt-ws-body[data-picture]")) return true;
    return (
      t.closest(
        "button, a, input, textarea, select, [role='slider'], [role='separator'], .tt-subs, .tt-stats, .tt-state-card, .tt-missed, [class*='tt-annotate'], [class*='tt-comment']",
      ) !== null
    );
  };
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || own(e)) return;
    clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(onToggle, DOUBLE_CLICK_MS);
  };
  const onDoubleClick = (e: MouseEvent) => {
    if (own(e)) return;
    clearTimeout(clickTimer.current);
    onFullscreen();
  };
  // A share that starts (or is there when the page opens) comes forward.
  const sharing = sources.includes("screen");
  const openPanel = workspace.open;
  useEffect(() => {
    if (sharing) openPanel("screen");
  }, [sharing, openPanel]);
  const offLayout = useOffLayout();
  const card = state.card;
  // A card that replaces the talk (no room, connecting, failed) shows alone: no faint panels behind it.
  const covered = card !== undefined && !card.dim && !card.replay && view.timeline.liveEdge === undefined;
  const needsGesture = media !== undefined && !ui.playing && view.timeline.mode === "live" && !card;

  const extra = useMemo(() => Object.fromEntries(extraTabs.map((t) => [t.id, t.content])), [extraTabs]);
  const content: Record<string, ReactNode> = {
    ...(sources.includes("camera")
      ? { camera: <CameraSurface offLayout={wholePicture(offLayout, sources)} alone /> }
      : {}),
    ...(sources.includes("slides") ? { slides: <SlideSurface /> } : {}),
    ...(sources.includes("screen") ? { screen: <ScreenSurface /> } : {}),
    chat: <ChatTab />,
    transcript: <TranscriptPanel />,
    chapters: <ChaptersPanel />,
    ...extra,
  };

  const overlay = (
    <>
      <SubtitleOverlay stageRef={overlayRef} />
      {view.missed && !card && !ui.stats ? (
        <div className="tt-missed" role="status">
          <span>
            You missed {formatClock(view.missed.toMs - view.missed.fromMs)}
            {view.missed.chapters.length > 0
              ? ` (${view.missed.chapters.length} chapter${view.missed.chapters.length === 1 ? "" : "s"})`
              : ""}
            . Catch up:
          </span>
          {view.missed.chapters.length > 0 || (view.missed.outlineAnnounced && !view.missed.outlineOn) ? (
            <button
              type="button"
              className="tt-link"
              onClick={() => {
                openTab("chapters");
                playback.dismissMissed();
              }}
            >
              Chapters
            </button>
          ) : null}
          <button
            type="button"
            className="tt-link"
            onClick={() => {
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
    </>
  );

  return (
    <div
      className={`tt-stage tt-stage-ws${card?.dim ? " tt-dimmed" : ""}${covered ? " tt-covered" : ""}${
        sourcesPending ? " tt-sources-pending" : ""
      }`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        if (!(e.target as Element).closest?.(".tt-ws-body[data-picture]")) return;
        e.preventDefault();
        setUi((u) => ({ stats: !u.stats, menu: undefined }));
      }}
    >
      <TileAspects.Provider value={report}>
        <Workspace api={workspace} content={content} overlay={overlay} overlayRef={overlayRef} aspects={aspects} />
      </TileAspects.Provider>

      {ui.stats ? <StatsForNerds /> : null}

      {needsGesture ? (
        <button type="button" className="tt-big-play" onClick={onToggle}>
          <Icon name="play" />
          <span>Play the talk</span>
        </button>
      ) : null}

      {card ? (
        // A replay card lets the last frame show through (data-over): the talk's own picture, not an empty ground.
        <div className="tt-state-card" role="status" data-kind={state.kind} data-over={card.replay ? "" : undefined}>
          {card.replay || card.hub ? null : <span className="tt-state-glyph" aria-hidden="true" />}
          <strong>{card.title}</strong>
          {card.body ? <span>{card.body}</span> : null}
          {card.retry || card.replay || card.hub ? (
            <div className="tt-state-actions">
              {card.retry ? (
                <button type="button" className="tt-button" onClick={() => location.reload()}>
                  Try again
                </button>
              ) : null}
              {card.replay ? (
                <button type="button" className="tt-button" onClick={() => seek(view.timeline.start)}>
                  Replay from the start
                </button>
              ) : null}
              {card.hub ? (
                <Link href="/" className="tt-button tt-secondary">
                  All talks
                </Link>
              ) : null}
            </div>
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

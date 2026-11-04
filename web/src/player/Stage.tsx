import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatClock } from "../playback/timeline";
import { Link } from "../router";
import { CameraSurface, useOffLayout } from "./CameraSurface";
import { usePlayer } from "./context";
import { useFrameValue } from "./frameClock";
import { Icon } from "./icons";
import { type BoardKind, clamp, type LayoutKind, PIP_WIDTH, type Prefs, type SourceKind } from "./prefs";
import { ScreenSurface } from "./ScreenSurface";
import { SlideSurface, useSlideTime } from "./SlideSurface";
import { TileAspects } from "./SourceTile";
import { fitStage, type StageFit } from "./stageFit";
import { StatsForNerds } from "./StatsForNerds";
import { SubtitleOverlay } from "./SubtitleOverlay";

/** A click on the stage waits this long for a second one (a double-click is full screen, not play and pause). */
const DOUBLE_CLICK_MS = 250;

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
 * the main picture), and the main picture. A shared screen takes the slides' place unless the listener picks the
 * slides back; the one not picked stays mounted, hidden.
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
 * Whether the camera's whole picture is the stage: a composed lecture video off its layout (a stage shot, a title
 * card, a zoom on a slide) is one picture, shown large and alone, with no slide card or corner tile beside it. A
 * shared screen keeps its place.
 */
export function wholePicture(offLayout: boolean, sources: readonly SourceKind[]): boolean {
  return offLayout && sources.includes("camera") && !sources.includes("screen");
}

/**
 * Whether the camera has the stage to itself because there is no slide to show: the room has slides and a camera and
 * no shared screen, and at this moment the speaker shows no slide (and no description stands in for one). An empty
 * slide card is not a picture worth the stage (decision 0036); the speaker is.
 */
export function cameraAlone(noSlide: boolean, sources: readonly SourceKind[]): boolean {
  return noSlide && sources.includes("camera") && sources.includes("slides") && !sources.includes("screen");
}

/** Whether a source is on screen: present, and in the layout (single shows the one chosen). */
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
 * The canvas (ui-design §3.1–§3.2, decision 0026): by default the slides fill it and the camera sits in a corner
 * tile the listener can drag, resize or swap; with no deck the camera fills it; side by side (a draggable divider)
 * and one at a time are options. Over them the subtitles, "What you missed", Stats for nerds and the state cards of
 * §5. Both source tiles stay mounted in one place in every layout (CSS moves them), so the live canvas is never
 * re-created.
 */
export function Stage({ onToggle, onFullscreen }: { onToggle: () => void; onFullscreen: () => void }) {
  const {
    prefs,
    update,
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
    slides,
    clock,
    tracks,
    looped,
    vod,
  } = usePlayer();
  const stage = useRef<HTMLDivElement>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  // Click plays or pauses, double-click is full screen (any streaming player). A click on something of its own (a
  // button, the subtitles, the corner tile's handles, the annotation tools, a card) is that thing's; while drawing,
  // the stage is the drawing surface.
  const annotating = listening?.get().annotating ?? false;
  const own = (e: MouseEvent) =>
    annotating ||
    (e.target as Element).closest?.(
      "button, a, input, textarea, select, [role='slider'], [role='separator'], [role='dialog'], .tt-subs, .tt-pip-handle, .tt-pip-grip, .tt-stats, .tt-state-card, .tt-missed, [class*='tt-annotate'], [class*='tt-comment']",
    ) !== null;
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
  // A share that starts (or is there when the page opens) comes forward; the listener can pick the slides back.
  const sharing = sources.includes("screen");
  useEffect(() => {
    if (sharing) update({ board: "screen" });
  }, [sharing, update]);
  const offLayout = useOffLayout();
  // No slide at the frame on screen (the slide track says none, no description stands in) and, in a demo lecture, none
  // seen before it in this session: the camera alone, centred. In a demo lecture a slide seen earlier stays up instead
  // (SlideSurface holds it); a live speaker's Hide slides is theirs, and the console tells them viewers see the camera.
  const slideTime = useSlideTime();
  const holds = looped || vod === true;
  const described = tracks.describe?.enabled ? tracks.describe.sliced?.slide : undefined;
  const noSlide = useFrameValue(clock, (t) => {
    const time = slideTime(t);
    const now = slides?.slideAt(time);
    return (
      now !== undefined && !now.slide && described === undefined && !(holds && slides?.heldSlide(time) !== undefined)
    );
  });
  // The camera with no picture yet (before play, the first segment loading) is left out while there is another picture
  // to show: an empty box labelled "Camera" is not one. It stays mounted, so the live canvas is never re-created.
  const [cameraBlank, setCameraBlank] = useState(false);
  const cameraOut =
    cameraBlank && !wholePicture(offLayout, sources) && !cameraAlone(noSlide, sources) && sources.length > 1;
  const pictured = cameraOut ? sources.filter((k) => k !== "camera") : sources;
  const offWhole = wholePicture(offLayout, pictured);
  // Before the first slide the camera is the stage's only picture, but not a video call: centred, at most CAMERA_CAP of
  // the stage's width. Off its layout the recorded frame is one picture on purpose, shown whole.
  const capped = !offWhole && cameraAlone(noSlide, pictured);
  const whole = offWhole || capped;
  const placed = stageSources(pictured, prefs.board);
  const layout = whole ? "single" : effectiveLayout(prefs.layout, placed);
  const hasCamera = sources.includes("camera");
  const hasSlides = sources.includes("slides");
  const hasScreen = sources.includes("screen");
  // The main picture and the corner one (the camera, or with no camera the other of slides and screen). The source
  // not placed stays mounted, hidden, so picking it back is instant.
  const board: SourceKind = placed.at(-1) ?? "slides";
  const cornerKind: SourceKind = placed.length > 1 ? placed[0]! : "camera";
  // Which source is "first": the left one in split, the corner tile in the default layout.
  const first: SourceKind = prefs.swap ? board : cornerKind;
  // Until the room says what it sends, no picture: the tiles stay mounted (the live canvas with them), unseen.
  const shown = (kind: SourceKind) => !sourcesPending && sourceShown(kind, prefs, pictured, offLayout, noSlide);
  const role = (kind: SourceKind) =>
    layout === "pip" ? (kind === first ? "small" : "main") : layout === "split" ? (kind === first ? "a" : "b") : "main";

  const pip = prefs.pipPos;
  const fit = useStageFit(stage, {
    layout,
    small: layout === "pip" && placed.length > 1 && shown(first) ? first : undefined,
    main: whole ? "camera" : first === cornerKind || placed.length < 2 ? board : cornerKind,
    mainWidthFrac: capped ? CAMERA_CAP : undefined,
    placedByViewer: pip !== undefined,
    prefs,
  });
  const style = {
    "--split": prefs.split,
    "--pip-w": prefs.pipWidth,
    "--corner-ar": fit.cornerAspect,
    "--fit-right": `${fit.layout?.right ?? 0}px`,
    "--fit-bottom": `${fit.layout?.bottom ?? 0}px`,
    "--fit-top": `${fit.layout?.top ?? 0}px`,
    ...(fit.layout?.corner && fit.width
      ? { "--fit-corner-right": `${fit.width - fit.layout.corner.left - fit.layout.corner.width}px` }
      : {}),
    ...(pip ? { "--pip-x": pip.x, "--pip-y": pip.y } : {}),
  } as CSSProperties;
  // Low, under the main picture, while it leaves the subtitles clear; a caption that wraps taller than the band's
  // estimate sends it to the top for the rest of this notice (it never moves back and forth).
  const subsInWay = useSubtitlesInWay(stage, view.missed && fit.missedLow ? view.missed.fromMs : undefined);
  const missedLow = fit.missedLow && !subsInWay;
  const card = state.card;
  // A card that replaces the talk (no room, connecting, failed) shows alone: no faint tiles or labels behind it.
  const covered = card !== undefined && !card.dim && !card.replay && view.timeline.liveEdge === undefined;
  const needsGesture = media !== undefined && !ui.playing && view.timeline.mode === "live" && !card;
  const corner = (kind: SourceKind) =>
    layout === "pip" && role(kind) === "small" ? (
      <CornerTools stageRef={stage} other={kind === cornerKind ? board : cornerKind} />
    ) : null;

  return (
    <TileAspects.Provider value={fit.report}>
      <div
        ref={stage}
        className={`tt-stage tt-layout-${layout}${prefs.swap ? " tt-swapped" : ""}${pip ? " tt-pip-placed" : ""}${
          card?.dim ? " tt-dimmed" : ""
        }${covered ? " tt-covered" : ""}${capped ? " tt-camera-capped" : ""}`}
        style={style}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setUi((u) => ({ stats: !u.stats, menu: undefined }));
        }}
      >
        {hasCamera ? (
          <div className={`tt-cell tt-cell-camera tt-cell-${role("camera")}${shown("camera") ? "" : " tt-hidden"}`}>
            {corner("camera")}
            <CameraSurface offLayout={wholePicture(offLayout, sources)} alone={whole} onBlank={setCameraBlank} />
          </div>
        ) : null}
        {layout === "split" ? <SplitDivider stageRef={stage} names={[cornerKind, board]} /> : null}
        {hasSlides ? (
          <div className={`tt-cell tt-cell-slides tt-cell-${role("slides")}${shown("slides") ? "" : " tt-hidden"}`}>
            {corner("slides")}
            <SlideSurface />
          </div>
        ) : null}
        {hasScreen ? (
          <div className={`tt-cell tt-cell-screen tt-cell-${role("screen")}${shown("screen") ? "" : " tt-hidden"}`}>
            {corner("screen")}
            <ScreenSurface />
          </div>
        ) : null}

        <SubtitleOverlay stageRef={stage} below={fit.layout?.captions} />

        {view.missed && !card && !ui.stats ? (
          <div className="tt-missed" role="status" data-low={missedLow ? "" : undefined}>
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
    </TileAspects.Provider>
  );
}

/** How often the low "What you missed" checks the subtitles beside it, ms. */
const MISSED_CHECK_MS = 250;
/** The space kept between the subtitles and "What you missed", px. */
const MISSED_CLEAR = 4;

/**
 * Whether the subtitles reach into the low "What you missed" (keyed by the notice, undefined while it is not low): the
 * band's room is an estimate, and a long caption can wrap taller. Once they do, it stays true for that notice.
 */
function useSubtitlesInWay(stage: RefObject<HTMLDivElement | null>, notice: number | undefined): boolean {
  const [inWay, setInWay] = useState<number>();
  const blocked = notice !== undefined && inWay === notice;
  useEffect(() => {
    const el = stage.current;
    if (!el || notice === undefined || blocked) return;
    const check = () => {
      const subs = el.querySelector(".tt-subs")?.getBoundingClientRect();
      const note = el.querySelector(".tt-missed")?.getBoundingClientRect();
      if (!subs || !note || subs.height === 0) return;
      const overlaps =
        subs.bottom + MISSED_CLEAR > note.top &&
        subs.top < note.bottom + MISSED_CLEAR &&
        subs.right > note.left &&
        subs.left < note.right;
      if (overlaps) setInWay(notice);
    };
    check();
    const timer = setInterval(check, MISSED_CHECK_MS);
    return () => clearInterval(timer);
  }, [stage, notice, blocked]);
  return blocked;
}

/** The camera alone before the first slide: its widest, as a fraction of the stage (player.css .tt-camera-capped). */
const CAMERA_CAP = 0.64;
/** The space between the pictures on the stage, px (player.css `.tt-stage` gap and the dock gap). */
const FIT_GAP = 12;
/** The height "What you missed" needs in the band under the main picture, px. */
const MISSED_ROOM = 48;
/** The dock's reach above the stage's bottom edge when player.css cannot be read, px. */
const DOCK_REACH = 112;
/** The title's reach below the stage's top edge when player.css cannot be read, px. */
const TITLE_REACH = 64;

/**
 * The stage's size and its tiles' shapes, and from them where the main picture goes (`fitStage`): the corner tile
 * the player places and the subtitles the viewer has not moved never cover the slides or a shared screen.
 */
function useStageFit(
  stage: RefObject<HTMLDivElement | null>,
  {
    layout,
    small,
    main,
    mainWidthFrac,
    placedByViewer,
    prefs,
  }: {
    layout: LayoutKind;
    /** The corner tile's source, while it shows. */
    small: SourceKind | undefined;
    /** The main picture's source. */
    main: SourceKind;
    /** The main picture's widest, as a fraction of the stage's width (the camera alone before the first slide). */
    mainWidthFrac: number | undefined;
    placedByViewer: boolean;
    prefs: Prefs;
  },
): {
  report: (kind: SourceKind, aspect: number) => void;
  layout: StageFit | undefined;
  /** The stage's width, px, once measured. */
  width: number | undefined;
  cornerAspect: number;
  /** The band under the main picture has room for "What you missed" beside the subtitles, off the slide. */
  missedLow: boolean;
} {
  const [size, setSize] = useState<{ width: number; height: number; dockReach: number; titleReach: number }>();
  const [aspects, setAspects] = useState<Partial<Record<SourceKind, number>>>({});
  const report = useCallback((kind: SourceKind, aspect: number) => {
    setAspects((a) => (Math.abs((a[kind] ?? 0) - aspect) < 1e-3 ? a : { ...a, [kind]: aspect }));
  }, []);
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const css = getComputedStyle(el);
      const dockReach = parseFloat(css.getPropertyValue("--player-dock-reach")) || DOCK_REACH;
      const titleReach = parseFloat(css.getPropertyValue("--player-title-reach")) || TITLE_REACH;
      const { width, height } = el.getBoundingClientRect();
      setSize((s) =>
        s && s.width === width && s.height === height && s.dockReach === dockReach && s.titleReach === titleReach
          ? s
          : { width, height, dockReach, titleReach },
      );
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stage]);
  const cornerAspect = (small && aspects[small]) || 16 / 9;
  const lines = prefs.style.lines;
  const captions = prefs.cc ? Math.ceil(lines * prefs.style.size * 1.3 + 12) : undefined;
  const layoutFit =
    size && size.width > 0 && size.height > 0
      ? fitStage({
          width: size.width,
          height: size.height,
          main: aspects[main] ?? 16 / 9,
          mainWidthFrac,
          corner:
            layout === "pip" && small && !placedByViewer
              ? { aspect: cornerAspect, widthFrac: prefs.pipWidth }
              : undefined,
          captions,
          dockReach: size.dockReach,
          titleReach: size.titleReach,
          gap: FIT_GAP,
        })
      : undefined;
  const free = layoutFit && size ? layoutFit.bottom - size.dockReach - FIT_GAP - (captions ?? 0) : 0;
  return { report, layout: layoutFit, width: size?.width, cornerAspect, missedLow: free >= MISSED_ROOM };
}

/** The split divider: drag, or arrow keys when focused, to move it. */
function SplitDivider({
  stageRef,
  names,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  names: readonly [SourceKind, SourceKind];
}) {
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
      aria-label={`Resize the ${names[0]} and ${names[1]}`}
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

/** The corner tile's box as fractions of the stage, read from where it is drawn (its default place is CSS's). */
function tileBox(tile: Element | null | undefined, rect: DOMRect): { x: number; y: number; w: number; h: number } {
  const t = tile?.getBoundingClientRect();
  if (!t || rect.width === 0 || rect.height === 0) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: (t.left - rect.left) / rect.width,
    y: (t.top - rect.top) / rect.height,
    w: t.width / rect.width,
    h: t.height / rect.height,
  };
}

/**
 * The corner tile's tools (decision 0026): drag it anywhere on the stage, drag its grip to resize it (the opposite
 * corner stays put), swap it with the main picture (the button, or a double click). It is kept inside the stage.
 */
function CornerTools({ stageRef, other }: { stageRef: RefObject<HTMLDivElement | null>; other: SourceKind }) {
  const { prefs, update } = usePlayer();
  const drag = useRef<
    { mode: "move" | "size"; x: number; y: number; box: { x: number; y: number; w: number; h: number } } | undefined
  >(undefined);
  const start = (mode: "move" | "size", e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, box: tileBox(e.currentTarget.closest(".tt-cell"), rect) };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!d || !rect || rect.width === 0 || rect.height === 0 || d.box.w === 0) return;
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    const ratio = d.box.h / d.box.w;
    if (d.mode === "move") {
      update({
        pipPos: { x: clamp(d.box.x + dx, 0, 1 - d.box.w), y: clamp(d.box.y + dy, 0, Math.max(0, 1 - d.box.h)) },
      });
      return;
    }
    // The grip is the top-left corner: dragging it out grows the tile, its bottom-right corner fixed.
    const right = d.box.x + d.box.w;
    const bottom = d.box.y + d.box.h;
    const grow = Math.max(-dx, -dy / ratio);
    const w = clamp(d.box.w + grow, PIP_WIDTH.min, Math.min(PIP_WIDTH.max, right, bottom / ratio));
    update({ pipWidth: w, pipPos: { x: right - w, y: bottom - w * ratio } });
  };
  const end = () => (drag.current = undefined);
  const swap = () => update({ swap: !prefs.swap });
  return (
    <>
      <div
        className="tt-pip-handle"
        title="Drag to move · double-click to swap"
        aria-hidden="true"
        onPointerDown={(e) => start("move", e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={swap}
      />
      <span
        className="tt-pip-grip"
        title="Drag to resize"
        aria-hidden="true"
        onPointerDown={(e) => start("size", e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <button
        type="button"
        className="tt-icon-button tt-small tt-pip-swap"
        aria-label={`Swap: ${other} in the corner`}
        onClick={swap}
      >
        <Icon name="swap" />
      </button>
    </>
  );
}

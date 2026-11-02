import { type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useRef } from "react";
import { RoomStateChalky } from "../brand/states";
import { formatClock } from "../playback/timeline";
import { Link } from "../router";
import { CameraSurface } from "./CameraSurface";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { type BoardKind, clamp, type LayoutKind, PIP_WIDTH, type Prefs, type SourceKind } from "./prefs";
import { ScreenSurface } from "./ScreenSurface";
import { SlideSurface } from "./SlideSurface";
import { StatsForNerds } from "./StatsForNerds";
import { SubtitleOverlay } from "./SubtitleOverlay";

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

/** Whether a source is on screen: present, and in the layout (single shows the one chosen). */
export function sourceShown(
  kind: SourceKind,
  prefs: Pick<Prefs, "layout" | "single" | "board">,
  sources: readonly SourceKind[],
): boolean {
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
export function Stage() {
  const { prefs, update, sources, ui, setUi, state, view, playback, media, togglePlay, openTab, seek } = usePlayer();
  const stage = useRef<HTMLDivElement>(null);
  // A share that starts (or is there when the page opens) comes forward; the listener can pick the slides back.
  const sharing = sources.includes("screen");
  useEffect(() => {
    if (sharing) update({ board: "screen" });
  }, [sharing, update]);
  const placed = stageSources(sources, prefs.board);
  const layout = effectiveLayout(prefs.layout, placed);
  const hasCamera = placed.includes("camera");
  const hasSlides = sources.includes("slides");
  const hasScreen = sources.includes("screen");
  // The main picture and the corner one (the camera, or with no camera the other of slides and screen). The source
  // not placed stays mounted, hidden, so picking it back is instant.
  const board: SourceKind = placed.at(-1) ?? "slides";
  const cornerKind: SourceKind = placed.length > 1 ? placed[0]! : "camera";
  // Which source is "first": the left one in split, the corner tile in the default layout.
  const first: SourceKind = prefs.swap ? board : cornerKind;
  const shown = (kind: SourceKind) => sourceShown(kind, prefs, sources);
  const role = (kind: SourceKind) =>
    layout === "pip" ? (kind === first ? "small" : "main") : layout === "split" ? (kind === first ? "a" : "b") : "main";

  const pip = prefs.pipPos;
  const style = {
    "--split": prefs.split,
    "--pip-w": prefs.pipWidth,
    ...(pip ? { "--pip-x": pip.x, "--pip-y": pip.y } : {}),
  } as CSSProperties;
  const card = state.card;
  const needsGesture = media !== undefined && !ui.playing && view.timeline.mode === "live" && !card;
  const corner = (kind: SourceKind) =>
    layout === "pip" && role(kind) === "small" ? (
      <CornerTools stageRef={stage} other={kind === cornerKind ? board : cornerKind} />
    ) : null;

  return (
    <div
      ref={stage}
      className={`tt-stage tt-layout-${layout}${prefs.swap ? " tt-swapped" : ""}${pip ? " tt-pip-placed" : ""}${
        card?.dim ? " tt-dimmed" : ""
      }`}
      style={style}
      onContextMenu={(e) => {
        e.preventDefault();
        setUi((u) => ({ stats: !u.stats, menu: undefined }));
      }}
    >
      {hasCamera ? (
        <div className={`tt-cell tt-cell-camera tt-cell-${role("camera")}${shown("camera") ? "" : " tt-hidden"}`}>
          {corner("camera")}
          <CameraSurface />
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
              openTab("chapters");
              playback.dismissMissed();
            }}
          >
            Chapters
          </button>
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
        <button type="button" className="tt-big-play" onClick={togglePlay}>
          <Icon name="play" />
          <span>Play the talk</span>
        </button>
      ) : null}

      {card ? (
        <div className="tt-state-card" role="status">
          <RoomStateChalky kind={state.kind} />
          <strong>{card.title}</strong>
          {card.body ? <span>{card.body}</span> : null}
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
            <Link href="/" className="tt-link">
              Back to the hub
            </Link>
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

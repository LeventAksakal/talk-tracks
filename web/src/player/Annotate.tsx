// Listener tools on the slide tile (decisions 0021, 0024; ui-design §12): pen, marker, the speaker's shapes, underline,
// highlight, eraser, undo and redo of one's own work, clear mine, and the comment tool that anchors a comment on a
// region or a text range of the slide. A tool's colour and width open in a popover from it, as on the console. Writes
// go to the room service, never the relay; what comes back on the room service's tracks is what everyone sees. Also
// the comments anchored on the slide, outlined where they point.

import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from "react";
import { marksAt, rangeBetween, rangeBoxes, strokesAt } from "../annotate/geometry";
import { type Thread, threadsAt } from "../annotate/threads";
import { shapeEnd } from "../canvas/ink";
import { SHAPE_LABELS, WIDTH_NAMES, WIDTHS, type WidthStep } from "../canvas/tools";
import type { Anchor, Author, CommentRecord, Point, Region, ShowSlide, TextRun } from "../contracts/types";
import { mayChange } from "../contracts/types";
import { usePlayer } from "./context";
import { useFrameValue } from "./frameClock";
import {
  DRAWING_TOOLS,
  LISTENER_INKS,
  type Listening,
  type ListenerTool,
  hasColor,
  hasWidth,
  isShape,
  useListening,
  useRoomService,
} from "./listening";
import type { SlideTracks } from "./slideTracks";
import { CHALK_BOX, inkColor } from "../theme/ink";

/** The Discussion tab's id in the side panel. */
export const DISCUSSION_TAB = "discussion";

/** A press that moves less than this (a fraction of the slide) is a click. */
const CLICK = 0.006;

const TOOLS: { tool: ListenerTool; label: string; title: string }[][] = [
  [
    { tool: "pen", label: "Pen", title: "Draw on the slide" },
    { tool: "highlighter", label: "Marker", title: "Highlighter: draw translucent" },
  ],
  [
    { tool: "rect", label: SHAPE_LABELS.rect, title: "Draw a rectangle (Shift: a square)" },
    { tool: "ellipse", label: SHAPE_LABELS.ellipse, title: "Draw an ellipse (Shift: a circle)" },
    { tool: "arrow", label: SHAPE_LABELS.arrow, title: "Draw an arrow (Shift: in 45° steps)" },
    { tool: "line", label: SHAPE_LABELS.line, title: "Draw a line (Shift: in 45° steps)" },
  ],
  [
    { tool: "underline", label: "Underline", title: "Underline text: drag across it or click a word" },
    { tool: "highlight", label: "Highlight", title: "Highlight text: drag across it or click a word" },
    { tool: "eraser", label: "Eraser", title: "Erase your strokes and marks" },
    { tool: "comment", label: "Comment", title: "Comment on a part of the slide: drag a box or click a word" },
  ],
];

const hasOptions = (t: ListenerTool) => hasColor(t) || hasWidth(t);

/** The stroke width a tool draws with at a width step. */
function widthOf(tool: ListenerTool, step: WidthStep): number {
  return (tool === "highlighter" ? WIDTHS.highlighter : isShape(tool) ? WIDTHS.shape : WIDTHS.pen)[step];
}

/** Whether a key press goes to a text field (the name, a comment), where Ctrl+Z is the field's own. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.closest === "function" && (el.isContentEditable || !!el.closest("input, textarea, select"));
}

/** Whether the playhead is at the live edge: drawing changes the live slide only. */
function useLive(): boolean {
  const { view } = usePlayer();
  return view.timeline.mode === "live";
}

/** The author a write of this browser gets stamped with, for what `mayChange` lets it erase. */
function useAuthor(listening: Listening | undefined): Author | undefined {
  useRoomService(listening?.service);
  const me = listening?.service.me();
  return me ? { id: me.id, name: me.name ?? "", ...(me.speaker ? { speaker: true } : {}) } : undefined;
}

/**
 * The tool bar on the slide tile: a button that opens it, then the tools (the active one's colour and width in a
 * popover from it), Undo, Redo and Clear mine. Drawing tools need the live slide and a display name, asked for here
 * once. Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z undo and redo one's own work on the slide while the tools are open.
 */
export function AnnotateBar({
  on,
  slides,
  time,
}: {
  on: ShowSlide | null;
  slides: SlideTracks;
  time: (t: number | undefined) => number | undefined;
}) {
  const { listening, clock } = usePlayer();
  const state = useListening(listening);
  useRoomService(listening?.service);
  const live = useLive();
  const author = useAuthor(listening);
  const [name, setName] = useState("");
  const canWrite = !!listening && listening.service.status() === "open" && !!on && live && !!author?.name;
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (e) => {
      if (!listening || !state?.annotating || !on || !canWrite || inTextField(e.target)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const redo = key === "y" || (key === "z" && e.shiftKey);
      if (key !== "z" && key !== "y") return;
      e.preventDefault();
      if (redo) listening.writer.redo(on);
      else listening.writer.undo(on);
    };
  });
  useEffect(() => {
    const fn = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  if (!listening || !state) return null;
  const service = listening.service;
  const status = service.status();
  const me = service.me();
  const needName = state.annotating && status === "open" && !me?.name;

  if (!state.annotating) {
    return (
      <div className="tt-annotate-bar">
        <button
          type="button"
          className="tt-annotate-open"
          onClick={() => listening.set({ annotating: true, error: undefined })}
          title="Draw, mark text and comment on the slide"
        >
          Annotate
        </button>
      </div>
    );
  }

  // Picking a tool opens its options; picking it again closes them, as on the console.
  const choose = (tool: ListenerTool) =>
    listening.set({ tool, error: undefined, optionsOpen: state.tool !== tool ? hasOptions(tool) : !state.optionsOpen });
  const { writer } = listening;
  const clearMine = () => {
    if (!on || !author) return;
    const t = time(clock.now());
    const elements = (slides.inkAt(t) ?? []).map((r) => r.data).filter((d) => mayChange(author, d.by));
    const marks = (slides.slideAt(t)?.marks ?? []).map((r) => r.data).filter((d) => mayChange(author, d.by));
    writer.clear(on, { elements, marks });
  };
  return (
    <div className="tt-annotate-bar" role="toolbar" aria-label="Annotation tools" data-open="true">
      {TOOLS.map((group, i) => (
        <span key={i} className="tt-annotate-group">
          {group.map(({ tool, label, title }) => {
            const disabled = status !== "open" || !on || (DRAWING_TOOLS.includes(tool) && !live);
            const active = state.tool === tool;
            const options = active && !disabled && hasOptions(tool);
            return (
              <span key={tool} className="tt-annotate-slot">
                <button
                  type="button"
                  className="tt-annotate-tool"
                  aria-pressed={active}
                  disabled={disabled}
                  title={title}
                  onClick={() => choose(tool)}
                >
                  {label}
                </button>
                {options ? (
                  <button
                    type="button"
                    className="tt-annotate-options"
                    aria-label={`${label} colour${hasWidth(tool) ? " and width" : ""}`}
                    aria-expanded={state.optionsOpen}
                    onClick={() => listening.set({ optionsOpen: !state.optionsOpen })}
                  >
                    <span style={{ "--swatch": state.color } as CSSProperties} />
                  </button>
                ) : null}
                {options && state.optionsOpen ? (
                  <ToolOptions
                    label={label}
                    color={state.color}
                    width={hasWidth(tool) ? state.width : undefined}
                    onColor={(color) => listening.set({ color })}
                    onWidth={(width) => listening.set({ width })}
                  />
                ) : null}
              </span>
            );
          })}
        </span>
      ))}
      <span className="tt-annotate-group">
        <button
          type="button"
          className="tt-annotate-tool"
          disabled={!canWrite || !writer.canUndo(on)}
          title="Undo your last change on this slide (Ctrl+Z)"
          onClick={() => on && writer.undo(on)}
        >
          Undo
        </button>
        <button
          type="button"
          className="tt-annotate-tool"
          disabled={!canWrite || !writer.canRedo(on)}
          title="Redo (Ctrl+Y)"
          onClick={() => on && writer.redo(on)}
        >
          Redo
        </button>
        <button
          type="button"
          className="tt-annotate-tool"
          disabled={!canWrite}
          title="Remove your strokes and marks from this slide"
          onClick={clearMine}
        >
          Clear mine
        </button>
      </span>
      <button
        type="button"
        className="tt-annotate-tool"
        title="Close the tools"
        onClick={() => listening.set({ annotating: false, askName: false })}
      >
        Done
      </button>
      {status !== "open" ? (
        <span className="tt-annotate-note" role="status">
          {status === "refused" ? "Annotations are not available" : "Connecting to the room service…"}
        </span>
      ) : !live && state.tool !== "comment" ? (
        <span className="tt-annotate-note" role="status">
          Go live to draw; comments work in a replay
        </span>
      ) : state.error ? (
        <span className="tt-annotate-note" role="status">
          {state.error}
        </span>
      ) : null}
      {needName || state.askName ? (
        <form
          className="tt-annotate-name"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            service.setName(name);
            listening.set({ askName: false, error: undefined });
          }}
        >
          <label>
            Your name
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoComplete="nickname" />
          </label>
          <button type="submit" className="tt-annotate-tool">
            OK
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** The active tool's colour (the listener's pencils) and, for the pen, marker and shapes, its width. */
function ToolOptions({
  label,
  color,
  width,
  onColor,
  onWidth,
}: {
  label: string;
  color: string;
  width: WidthStep | undefined;
  onColor: (c: string) => void;
  onWidth: (w: WidthStep) => void;
}) {
  return (
    <div className="tt-annotate-popover" role="group" aria-label={`${label} options`}>
      <span className="tt-annotate-colors" role="radiogroup" aria-label="Colour">
        {LISTENER_INKS.map((name) => {
          const c = inkColor(name);
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={CHALK_BOX.find((i) => i.name === name)!.label}
              className="tt-annotate-color"
              style={{ "--swatch": c } as CSSProperties}
              onClick={() => onColor(c)}
            />
          );
        })}
      </span>
      {width !== undefined ? (
        <span className="tt-annotate-widths" role="radiogroup" aria-label="Stroke width">
          {([0, 1, 2] as const).map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={w === width}
              aria-label={WIDTH_NAMES[w]}
              className="tt-annotate-width"
              onClick={() => onWidth(w)}
            >
              <span style={{ height: `${2 + w * 2}px` }} />
            </button>
          ))}
        </span>
      ) : null}
      <span className="tt-annotate-hint">Closes when you draw</span>
    </div>
  );
}

type Drag = { from: Point; to: Point; tool: ListenerTool; erased: Set<string> };

/**
 * The surface the tools work on, over the slide: it takes the pointer only while a tool is usable, and shows what a
 * drag is about to make (a text range, a comment's box). Strokes being drawn go to the ink canvas as drafts.
 */
export function AnnotateSurface({
  slides,
  on,
  runs,
  aspect,
  time,
}: {
  slides: SlideTracks;
  on: ShowSlide | null;
  runs: readonly TextRun[];
  aspect: number;
  time: (t: number | undefined) => number | undefined;
}) {
  const { listening, clock, openTab } = usePlayer();
  const state = useListening(listening);
  const live = useLive();
  const author = useAuthor(listening);
  const drag = useRef<Drag | undefined>(undefined);
  const [preview, setPreview] = useState<{ boxes: Region[]; region?: Region } | undefined>();
  if (!listening || !state?.annotating || !on) return null;
  const ready = listening.service.status() === "open" && Boolean(author?.name);
  const usable = state.tool === "comment" ? listening.service.status() === "open" : ready && live;
  if (!usable) return null;

  const point = (e: PointerEvent<HTMLDivElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = r.width ? (e.clientX - r.left) / r.width : 0;
    const y = r.height ? (e.clientY - r.top) / r.height : 0;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  };

  const erase = (p: Point, d: Drag) => {
    const t = time(clock.now());
    const strokes = (slides.inkAt(t) ?? []).filter((s) => author && mayChange(author, s.data.by));
    const marks = (slides.slideAt(t)?.marks ?? []).filter((k) => author && mayChange(author, k.data.by));
    const hitStrokes = strokesAt(strokes, p, aspect).filter((id) => !d.erased.has(id));
    const hitMarks = marksAt(marks, runs, p).filter((id) => !d.erased.has(id));
    for (const id of [...hitStrokes, ...hitMarks]) d.erased.add(id);
    listening.writer.erase(
      hitStrokes,
      strokes.map((s) => s.data),
    );
    listening.writer.unmark(
      hitMarks,
      marks.map((k) => k.data),
    );
  };

  /** Where a shape's drag ends: Shift makes it even (a square, a circle, 45° steps). */
  const shapeAt = (d: Drag, p: Point, even: boolean): Point =>
    isShape(d.tool) ? shapeEnd(d.tool, d.from, p, aspect, even) : p;

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (state.optionsOpen) listening.set({ optionsOpen: false });
    const p = point(e);
    const d: Drag = { from: p, to: p, tool: state.tool, erased: new Set() };
    drag.current = d;
    const width = widthOf(d.tool, state.width);
    if (d.tool === "pen" || d.tool === "highlighter") {
      const stroke = listening.writer.begin(on, d.tool, state.color, p, width);
      if (stroke) listening.addDraft(stroke);
    } else if (isShape(d.tool)) {
      const shape = listening.writer.beginShape(on, { shape: d.tool, color: state.color, width }, p);
      if (shape) listening.addDraft(shape);
    } else if (d.tool === "eraser") {
      listening.writer.startEdit(); // one sweep is one undo step
      erase(p, d);
    }
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    d.to = p;
    if (d.tool === "pen" || d.tool === "highlighter") {
      listening.writer.move(p); // the draft is the same object: the ink canvas sees its new points
    } else if (isShape(d.tool)) {
      listening.writer.shapeTo(shapeAt(d, p, e.shiftKey)); // the draft's end moves with it
    } else if (d.tool === "eraser") erase(p, d);
    else if (d.tool === "underline" || d.tool === "highlight") {
      const range = rangeBetween(runs, d.from, p);
      setPreview({ boxes: range ? rangeBoxes(runs, range) : [] });
    } else if (d.tool === "comment") setPreview({ boxes: [], region: box(d.from, p) });
  };

  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = undefined;
    setPreview(undefined);
    if (!d) return;
    const p = point(e);
    if (d.tool === "pen" || d.tool === "highlighter") {
      const stroke = listening.writer.end();
      if (stroke) listening.addDraft(stroke);
    } else if (isShape(d.tool)) {
      const dragged = listening.writer.shaping();
      const shape = listening.writer.endShape(shapeAt(d, p, e.shiftKey));
      if (shape) listening.addDraft(shape);
      else if (dragged) listening.dropDraft(dragged.stroke); // a click: too short to draw
    } else if (d.tool === "eraser") {
      listening.writer.endEdit();
    } else if (d.tool === "underline" || d.tool === "highlight") {
      const range = rangeBetween(runs, d.from, p);
      if (range) listening.writer.mark(on, d.tool, state.color, range);
    } else if (d.tool === "comment") {
      listening.set({ anchor: anchorOf(on, runs, d.from, p) });
      openTab(DISCUSSION_TAB);
    }
  };

  return (
    <div
      className="tt-annotate-surface"
      data-tool={state.tool}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = undefined;
        setPreview(undefined);
        listening.writer.end();
        const dragged = listening.writer.shaping();
        if (!listening.writer.endShape() && dragged) listening.dropDraft(dragged.stroke);
        listening.writer.endEdit();
      }}
    >
      {preview?.boxes.map((b, i) => (
        <span key={i} className="tt-annotate-range" style={boxStyle(b)} />
      ))}
      {preview?.region ? <span className="tt-annotate-region" style={boxStyle(preview.region)} /> : null}
    </div>
  );
}

/** A comment's anchor from a press: a click on a word marks that word, a drag a box, a click elsewhere the slide. */
export function anchorOf(on: ShowSlide, runs: readonly TextRun[], from: Point, to: Point): Anchor {
  const base = { deck: on.deck, index: on.index };
  const moved = Math.hypot(to[0] - from[0], to[1] - from[1]) >= CLICK;
  if (!moved) {
    const span = rangeBetween(runs, from, from);
    return span ? { ...base, span } : base;
  }
  return { ...base, region: box(from, to) };
}

function box(a: Point, b: Point): Region {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

export function boxStyle(b: Region): CSSProperties {
  return { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` };
}

/** Where on the slide an anchor points: its region, or the boxes of its text range; none for the whole slide. */
export function anchorBoxes(anchor: Anchor, runs: readonly TextRun[]): Region[] {
  if (anchor.region) return [anchor.region];
  if (anchor.span?.length) return rangeBoxes(runs, anchor.span);
  return [];
}

/**
 * The threads to mark on the slide on screen at room time t (undefined: live, everything said so far): from the
 * room service's index when it is connected (hidden ones left out, a replay's comments at their `at`), else the
 * comments track's state at t.
 */
export function slideThreads(
  on: ShowSlide,
  index: readonly CommentRecord[] | undefined,
  track: readonly CommentRecord[] | undefined,
  t: number | undefined,
): Thread[] | undefined {
  const records = index ?? track;
  if (!records) return undefined;
  return threadsAt(records, { t: index ? t : undefined, filter: "slide", slide: on, order: "oldest" });
}

const sameThreads = (a: Thread[] | undefined, b: Thread[] | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((x, i) => x.comment.id === b[i]!.comment.id && x.replies.length === b[i]!.replies.length));

/**
 * The comments anchored on the slide on screen: a box where each points (its region or text range) with the
 * number of messages in its thread, and a count for those on the whole slide. A click opens the thread.
 */
export function CommentMarks({
  slides,
  on,
  runs,
  time,
}: {
  slides: SlideTracks;
  on: ShowSlide | null;
  runs: readonly TextRun[];
  time: (t: number | undefined) => number | undefined;
}) {
  const { clock, listening, openTab } = usePlayer();
  const state = useListening(listening);
  useRoomService(listening?.service);
  const live = useLive();
  const service = listening?.service;
  const index = service?.status() === "open" ? service.threads() : undefined;
  const threads = useFrameValue(
    clock,
    (t) =>
      on ? slideThreads(on, index, index ? undefined : slides.commentsAt(time(t)), live ? undefined : time(t)) : [],
    sameThreads,
  );
  if (!on || !threads?.length) return null;
  const open = (id: string) => {
    listening?.set({ focus: id });
    openTab(DISCUSSION_TAB);
  };
  const whole = threads.filter((th) => anchorBoxes(th.comment.anchor, runs).length === 0);
  return (
    <div className="tt-comment-marks">
      {threads.map(({ comment: c, replies }) => {
        const boxes = anchorBoxes(c.anchor, runs);
        if (boxes.length === 0) return null;
        const first = boxes[0]!;
        const focused = state?.focus === c.id;
        return (
          <div
            key={c.id}
            className="tt-comment-anchor"
            data-focus={focused || undefined}
            data-question={c.question || undefined}
          >
            {boxes.map((b, i) => (
              <span key={i} className="tt-comment-box" style={boxStyle(b)} />
            ))}
            <button
              type="button"
              className="tt-comment-badge"
              style={{ left: `${Math.min(0.97, first.x + first.w) * 100}%`, top: `${first.y * 100}%` }}
              title={`${c.by.name}: ${c.text}`}
              aria-label={`Comment by ${c.by.name}: ${c.text} (${replies.length} ${replies.length === 1 ? "reply" : "replies"})`}
              onClick={() => open(c.id)}
            >
              {1 + replies.length}
            </button>
          </div>
        );
      })}
      {whole.length ? (
        <button
          type="button"
          className="tt-comment-badge tt-comment-whole"
          title="Comments on this slide"
          onClick={() => open(whole[0]!.comment.id)}
        >
          {whole.length} on this slide
        </button>
      ) : null}
    </div>
  );
}

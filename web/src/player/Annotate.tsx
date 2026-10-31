// Listener tools on the slide tile (decisions 0021, 0024; ui-design §12): pen, highlighter, underline, highlight,
// eraser, clear mine, and the comment tool that anchors a comment on a region or a text range of the slide. Writes go
// to the room service, never the relay; what comes back on the room service's tracks is what everyone sees. Also the
// comments anchored on the slide, outlined where they point.

import { type CSSProperties, type PointerEvent, useRef, useState } from "react";
import { marksAt, rangeBetween, rangeBoxes, strokesAt } from "../annotate/geometry";
import { type Thread, threadsAt } from "../annotate/threads";
import type { Anchor, Author, CommentRecord, Point, Region, ShowSlide, TextRun } from "../contracts/types";
import { mayChange } from "../contracts/types";
import { usePlayer } from "./context";
import { useFrameValue } from "./frameClock";
import {
  DRAWING_TOOLS,
  LISTENER_COLORS,
  type Listening,
  type ListenerTool,
  useListening,
  useRoomService,
} from "./listening";
import type { SlideTracks } from "./slideTracks";

/** The Discussion tab's id in the side panel. */
export const DISCUSSION_TAB = "discussion";

/** A press that moves less than this (a fraction of the slide) is a click. */
const CLICK = 0.006;

const TOOLS: { tool: ListenerTool; label: string; title: string }[] = [
  { tool: "pen", label: "Pen", title: "Draw on the slide" },
  { tool: "highlighter", label: "Marker", title: "Highlighter: draw translucent" },
  { tool: "underline", label: "Underline", title: "Underline text: drag across it or click a word" },
  { tool: "highlight", label: "Highlight", title: "Highlight text: drag across it or click a word" },
  { tool: "eraser", label: "Eraser", title: "Erase your strokes and marks" },
  { tool: "comment", label: "Comment", title: "Comment on a part of the slide: drag a box or click a word" },
];

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
 * The tool bar on the slide tile: a button that opens it, then the tools, colours and Clear mine. Drawing tools need
 * the live slide and a display name, asked for here once.
 */
export function AnnotateBar({ on }: { on: ShowSlide | null }) {
  const { listening } = usePlayer();
  const state = useListening(listening);
  useRoomService(listening?.service);
  const live = useLive();
  const [name, setName] = useState("");
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

  const choose = (tool: ListenerTool) => listening.set({ tool, error: undefined });
  return (
    <div className="tt-annotate-bar" role="toolbar" aria-label="Annotation tools" data-open="true">
      {TOOLS.map(({ tool, label, title }) => {
        const disabled = status !== "open" || !on || (DRAWING_TOOLS.includes(tool) && !live);
        return (
          <button
            key={tool}
            type="button"
            className="tt-annotate-tool"
            aria-pressed={state.tool === tool}
            disabled={disabled}
            title={title}
            onClick={() => choose(tool)}
          >
            {label}
          </button>
        );
      })}
      <span className="tt-annotate-colors" role="radiogroup" aria-label="Colour">
        {LISTENER_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={state.color === c}
            aria-label={c}
            className="tt-annotate-color"
            style={{ "--swatch": c } as CSSProperties}
            onClick={() => listening.set({ color: c })}
          />
        ))}
      </span>
      <button
        type="button"
        className="tt-annotate-tool"
        disabled={status !== "open" || !on || !live || !me?.name}
        title="Remove your strokes and marks from this slide"
        onClick={() => on && listening.writer.clear(on)}
      >
        Clear mine
      </button>
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
    listening.writer.erase(hitStrokes);
    listening.writer.unmark(hitMarks);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    const d: Drag = { from: p, to: p, tool: state.tool, erased: new Set() };
    drag.current = d;
    if (d.tool === "pen" || d.tool === "highlighter") {
      const stroke = listening.writer.begin(on, d.tool, state.color, p);
      if (stroke) listening.addDraft(stroke);
    } else if (d.tool === "eraser") erase(p, d);
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    d.to = p;
    if (d.tool === "pen" || d.tool === "highlighter") {
      listening.writer.move(p); // the draft is the same object: the ink canvas sees its new points
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

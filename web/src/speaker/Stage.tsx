import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Point, TextRange } from "../contracts/types";
import type { RenderedSlide } from "./deck";
import { drawLaser, drawRange, drawStroke, marksAt, strokesAt } from "./draw";
import type { Tool } from "./keys";
import type { SlidesPublisher, StrokeStyle } from "./publisher";
import { rangeBetween } from "./runs";

/** Ink and laser samples go out at most this often (~20/s, decision 0018). */
export const SAMPLE_MS = 50;

export interface ToolColors {
  pen: string;
  highlighter: string;
  underline: string;
  highlight: string;
}

export const PEN_WIDTH = 0.004;
export const HIGHLIGHTER_WIDTH = 0.022;

/** The slide on screen with what is drawn on it, and the speaker's pen, laser, text and eraser tools. */
export function Stage({
  publisher,
  slide,
  aspect,
  tool,
  colors,
  hidden,
  label,
}: {
  publisher: SlidesPublisher;
  slide: RenderedSlide | undefined;
  aspect: number;
  tool: Tool;
  colors: ToolColors;
  hidden: boolean;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<{
    kind: Tool;
    stroke?: string;
    pending: Point[];
    lastSent: number;
    from?: Point;
    at?: Point;
    selection?: TextRange | null;
  } | null>(null);
  const frame = useRef(0);
  const runs = slide?.runs ?? [];
  const latest = useRef({ publisher, runs, colors });
  useLayoutEffect(() => {
    latest.current = { publisher, runs, colors };
  });

  const redraw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const { publisher: pub, runs: text, colors: ink } = latest.current;
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      const state = pub.state();
      for (const k of state.marks) drawRange(ctx, text, k.data.span, k.data.style, k.data.color, w, h);
      for (const s of state.strokes) drawStroke(ctx, s.data, w, h);
      const g = gesture.current;
      if (g?.selection) {
        const style = g.kind === "underline" ? "underline" : "highlight";
        drawRange(ctx, text, g.selection, style, ink[style], w, h);
      }
      const held = g?.kind === "laser" && g.at ? { m: 0, data: { kind: "at" as const, x: g.at[0], y: g.at[1] } } : undefined;
      drawLaser(ctx, held ?? state.pointer, w, h);
    });
  }, []);

  useEffect(() => publisher.onChange(redraw), [publisher, redraw]);
  useEffect(() => redraw());
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      redraw();
    };
    fit();
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    ro?.observe(canvas);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [redraw]);

  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = r.width ? (e.clientX - r.left) / r.width : 0;
    const y = r.height ? (e.clientY - r.top) / r.height : 0;
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  };

  const erase = (p: Point) => {
    const state = publisher.state();
    publisher.erase(strokesAt(state.strokes, p, aspect), marksAt(state.marks, runs, p));
  };

  const style = (): StrokeStyle =>
    tool === "highlighter"
      ? { tool: "highlighter", color: colors.highlighter, width: HIGHLIGHTER_WIDTH }
      : { tool: "pen", color: colors.pen, width: PEN_WIDTH };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (tool === "none" || hidden || e.button !== 0) return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture?.(e.pointerId);
    const p = at(e);
    const now = performance.now();
    if (tool === "pen" || tool === "highlighter") {
      gesture.current = { kind: tool, stroke: publisher.beginStroke(style(), p), pending: [], lastSent: now };
    } else if (tool === "laser") {
      gesture.current = { kind: tool, pending: [], lastSent: now, at: p };
      publisher.pointerAt(p[0], p[1]);
    } else if (tool === "underline" || tool === "highlight") {
      gesture.current = { kind: tool, pending: [], lastSent: now, from: p, selection: rangeBetween(runs, p, p) };
    } else if (tool === "eraser") {
      gesture.current = { kind: tool, pending: [], lastSent: now };
      erase(p);
    }
    redraw();
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g) return;
    const now = performance.now();
    const samples = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
    const points = (samples.length ? samples : [e]).map(at);
    const p = points.at(-1)!;
    if (g.kind === "pen" || g.kind === "highlighter") {
      g.pending.push(...points);
      if (g.stroke && now - g.lastSent >= SAMPLE_MS) {
        publisher.addPoints(g.stroke, g.pending.splice(0));
        g.lastSent = now;
      }
    } else if (g.kind === "laser") {
      g.at = p;
      if (now - g.lastSent >= SAMPLE_MS) {
        publisher.pointerAt(p[0], p[1]);
        g.lastSent = now;
      }
    } else if (g.kind === "underline" || g.kind === "highlight") {
      g.selection = g.from ? rangeBetween(runs, g.from, p) : null;
    } else if (g.kind === "eraser") {
      erase(p);
    }
    redraw();
  };

  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    const p = at(e);
    if ((g.kind === "pen" || g.kind === "highlighter") && g.stroke) {
      publisher.addPoints(g.stroke, g.pending.splice(0));
      publisher.endStroke(g.stroke);
    } else if (g.kind === "laser") {
      publisher.pointerAt(p[0], p[1]);
      publisher.pointerOff();
    } else if ((g.kind === "underline" || g.kind === "highlight") && g.from) {
      const range = rangeBetween(runs, g.from, p);
      if (range) publisher.mark(g.kind, colors[g.kind], range);
    }
    redraw();
  };

  return (
    <div className={`stage tool-${tool}`} style={{ aspectRatio: String(aspect) }}>
      {slide ? <img className="stage-image" src={slide.url} alt="" draggable={false} /> : null}
      <canvas
        ref={canvasRef}
        className="stage-ink"
        role="img"
        aria-label={label}
        data-testid="stage"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      {hidden ? (
        <div className="stage-hidden" role="status">
          Slides hidden from viewers. Press B to show them again.
        </div>
      ) : null}
    </div>
  );
}

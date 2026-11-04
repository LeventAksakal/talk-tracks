import { type CSSProperties, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { drawLaserTrail } from "../canvas/laser";
import type { Region } from "../contracts/types";
import { laserColor } from "../theme/ink";
import { dirOf } from "../viewer/lang";
import { AnnotateBar, AnnotateSurface, CommentMarks } from "./Annotate";
import { usePlayer } from "./context";
import { useFrameValue } from "./frameClock";
import { drawInk, inkSignature, markBoxes } from "./overlays";
import { SlideNav } from "./SlideNav";
import { navRange, type SlideRef } from "./deckNav";
import type { SlideAt, SlideTracks } from "./slideTracks";
import { SourceTile } from "./SourceTile";

const noop = () => () => {};
const zero = () => 0;

/** The time the slide overlays draw at: the frame on screen, or the playhead while rewound media is opening. */
export function useSlideTime(): (t: number | undefined) => number | undefined {
  const { playback } = usePlayer();
  return (t) => t ?? (playback.media.mode() === "rewound" ? playback.position() : undefined);
}

const sameSlide = (a: SlideAt | undefined, b: SlideAt | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.slide?.deck === b.slide?.deck &&
    a.slide?.index === b.slide?.index &&
    a.marks.length === b.marks.length &&
    a.marks.every((k, i) => k.data.id === b.marks[i]!.data.id && k.data.span === b.marks[i]!.data.span));

/**
 * The slide tile's shape: the picture's own, so the whole slide shows letterboxed in its cell, never stretched or cut
 * (a deck's slides need not share one shape: the deck's aspect is its first slide's); the deck's aspect until the
 * picture is in; 16:9 before anything is known.
 */
export function slideAspect(picture: { image: { width: number; height: number } } | undefined, deck?: number): number {
  const w = picture?.image.width ?? 0;
  const h = picture?.image.height ?? 0;
  if (w > 0 && h > 0) return w / h;
  return deck !== undefined && deck > 0 ? deck : 16 / 9;
}

interface Mark {
  id: string;
  style: "underline" | "highlight";
  color: string;
  box: Region;
}

/**
 * The slide on screen at the playhead (decisions 0017, 0020, 0021): the deck's image for the slide the slide track
 * shows, and over it, in the tile's overlay layer, the text marks (DOM boxes on the slide's text runs), the ink
 * (one canvas) and the laser (one element moved with a transform). Live and rewound alike: everything is the
 * state of the tracks at the room time of the frame on screen.
 */
export function SlideSurface() {
  const { tracks, slides, clock, audienceShown, openTab, looped, vod, playback } = usePlayer();
  const slideTime = useSlideTime();
  useSyncExternalStore(slides?.subscribe ?? noop, slides?.getVersion ?? zero);
  const at = useFrameValue(clock, (t) => slides?.slideAt(slideTime(t)), sameSlide);
  const describe = tracks.describe?.enabled ? tracks.describe : undefined;
  const described = describe?.sliced?.slide;
  const lang = describe?.lang ?? "en";
  const on = at?.slide ?? null;
  // A demo lecture shows no slide now: the last one seen here stays up, without its marks (they were on it then, not
  // now). A live speaker's Hide slides is honoured (Stage.tsx).
  const holds = looped || vod === true;
  const held = useFrameValue(
    clock,
    (t) => {
      if (!holds) return undefined;
      const time = slideTime(t);
      const now = slides?.slideAt(time);
      return now && !now.slide && described === undefined ? slides?.heldSlide(time) : undefined;
    },
    (a, b) => a === b || (a?.deck === b?.deck && a?.index === b?.index),
  );
  // The slide the speaker (or the playhead) is on, and the one the listener stays on after a step (deckNav.ts).
  const following = on ?? held ?? null;
  const [pinned, setPinned] = useState<SlideRef | null>(null);
  const pictured = pinned ?? following;
  // Off the speaker's slide: their marks, ink and laser are on another slide, so none of them show here.
  const off = pinned !== null && !(following && following.deck === pinned.deck && following.index === pinned.index);
  // Live (not a replay, not rewound) the listener follows the speaker and pages the slides shown so far; otherwise
  // the playhead, through the whole deck.
  const live = useFrameValue(clock, () => !holds && playback.media.mode() !== "rewound");
  const picture = pictured && slides ? slides.picture(pictured.deck, pictured.index) : undefined;
  const info = pictured && slides ? slides.deckInfo(pictured.deck) : undefined;
  const range =
    pictured && slides
      ? navRange({
          count: info?.count,
          whole: !live,
          shown: slides.furthestShown(pictured.deck),
          at: following?.deck === pictured.deck ? following.index : undefined,
        })
      : undefined;
  const aspect = slideAspect(picture, info?.aspect);
  const runs = picture?.image.runs ?? [];
  const marks: Mark[] =
    on && !off
      ? (at?.marks ?? []).flatMap(({ data }) =>
          markBoxes(data.span, runs).map((box, i) => ({
            id: `${data.id}:${i}`,
            style: data.style,
            color: data.color,
            box,
          })),
        )
      : [];
  const label = pictured ? `Slide ${pictured.index + 1}` : "Slides";
  // A slide's description is its picture's text alternative, and stands in for a slide with no picture.
  const description = off ? undefined : described?.description;

  return (
    <SourceTile
      kind="slides"
      aspect={aspect}
      label={label}
      chrome={
        slides && slides.isActive("slide") && pictured && picture ? (
          <SlideNav
            slides={slides}
            view={pictured}
            following={following}
            pinned={pinned}
            range={range}
            count={info?.count}
            live={live}
            onPin={setPinned}
          />
        ) : null
      }
      overlay={
        slides && slides.isActive("slide") ? (
          <>
            {off ? null : (
              <>
                <div className="tt-marks" aria-hidden="true">
                  {marks.map((k) => (
                    <span key={k.id} className={`tt-textmark tt-textmark-${k.style}`} style={markStyle(k)} />
                  ))}
                </div>
                {audienceShown ? <CommentMarks slides={slides} on={on} runs={runs} time={slideTime} /> : null}
                <InkLayer slides={slides} />
                <LaserPointer slides={slides} />
                <AnnotateSurface slides={slides} on={on} runs={runs} aspect={aspect} time={slideTime} />
                <AnnotateBar on={on} slides={slides} time={slideTime} />
              </>
            )}
          </>
        ) : null
      }
    >
      {picture ? (
        <img
          className="tt-slide-image"
          src={picture.url}
          alt={description ?? label}
          draggable={false}
          data-slide={pictured ? pictured.index + 1 : undefined}
        />
      ) : at === undefined && !description && slides?.isActive("slide") ? (
        // Subscribed, nothing read yet (a second or two on opening): the tile stays dark, so no placeholder copy on a
        // pale panel flashes before the first slide.
        <div className="tt-slide tt-slide-pending" />
      ) : (
        <div className="tt-slide">
          <strong className="tt-slide-title">{slideTitle()}</strong>
          {description ? (
            <p className="tt-slide-description" lang={lang} dir={dirOf(lang)}>
              {description}
            </p>
          ) : (
            <p className="tt-slide-hint">{hint()}</p>
          )}
          {!description && tracks.describe ? (
            <button type="button" className="tt-link" onClick={() => openTab("descriptions")}>
              Follow the slides as text
            </button>
          ) : null}
        </div>
      )}
    </SourceTile>
  );

  function slideTitle(): string {
    if (pictured) return `Slide ${pictured.index + 1}`;
    if (described) return `Slide ${described.id + 1}`;
    return at ? "No slide shown" : "Slides appear here";
  }

  function hint(): string {
    if (pictured) return "Loading the slide…";
    if (at) return "The speaker is not showing a slide right now.";
    return "The speaker's slides, ink and laser pointer show here.";
  }
}

function markStyle(k: Mark): CSSProperties {
  const { x, y, w, h } = k.box;
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${w * 100}%`,
    height: `${h * 100}%`,
    "--mark": k.color,
  } as CSSProperties;
}

/**
 * The ink canvas (decision 0020): its backing store in device pixels, redrawn on the frame loop only when the
 * elements visible at the frame's time change (a point, a stroke, a shape, an erase or an undo) or the size does.
 * While the group at the playhead loads, the last drawing stays.
 */
function InkLayer({ slides }: { slides: SlideTracks }) {
  const { clock, listening } = usePlayer();
  const slideTime = useSlideTime();
  const canvas = useRef<HTMLCanvasElement>(null);
  useDevicePixels(canvas);
  const time = useRef(slideTime);
  useEffect(() => {
    time.current = slideTime;
  });
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d", { alpha: true });
    if (!c || !ctx) return;
    let drawn = "";
    const draw = (t: number | undefined) => {
      const echoed = slides.inkAt(time.current(t));
      if (!echoed) return;
      // This browser's strokes show as drawn here until they come back on the track whole.
      const drafts = listening?.get().drafts ?? [];
      let strokes = echoed;
      if (drafts.length) {
        listening?.settle(echoed.map((s) => s.data));
        const own = new Set(drafts.map((d) => d.stroke));
        strokes = [...echoed.filter((s) => !own.has(s.data.stroke)), ...drafts.map((data) => ({ m: 0, data }))];
      }
      const sig = inkSignature(strokes, c.width, c.height);
      if (sig === drawn) return;
      drawn = sig;
      drawInk(
        ctx,
        strokes.map((s) => s.data),
        c.width,
        c.height,
      );
    };
    draw(clock.now());
    return clock.subscribe(draw);
  }, [slides, clock, listening]);
  return <canvas ref={canvas} className="tt-ink" aria-hidden="true" />;
}

/**
 * The laser (decision 0020): one element the size of the slide, translated by the pointer's fractions on the
 * compositor (a percentage of its own size is a fraction of the slide), shown only while the laser is on. Behind it
 * a canvas draws its fading trail from the pointer track at the frame's time (canvas/laser.ts), so a replay shows
 * the trail the room saw; the canvas is redrawn only while a trail is showing.
 */
function LaserPointer({ slides }: { slides: SlideTracks }) {
  const { clock } = usePlayer();
  const slideTime = useSlideTime();
  const el = useRef<HTMLDivElement>(null);
  const trailCanvas = useRef<HTMLCanvasElement>(null);
  useDevicePixels(trailCanvas);
  const time = useRef(slideTime);
  useEffect(() => {
    time.current = slideTime;
  });
  useEffect(() => {
    const d = el.current;
    if (!d) return;
    const c = trailCanvas.current;
    const ctx = c?.getContext("2d", { alpha: true });
    const color = laserColor();
    let last = "";
    let trailShown = false;
    const move = (t: number | undefined) => {
      const at = time.current(t);
      const p = slides.pointerAt(at);
      const key = p ? `${p.x.toFixed(4)},${p.y.toFixed(4)}` : "off";
      if (key !== last) {
        last = key;
        d.dataset.on = p ? "true" : "false";
        if (p) d.style.transform = `translate(${p.x * 100}%, ${p.y * 100}%)`;
      }
      if (!c || !ctx) return;
      const trail = slides.pointerTrail(at);
      if (trail.length < 2 && !trailShown) return;
      ctx.clearRect(0, 0, c.width, c.height);
      trailShown = trail.length >= 2;
      if (trailShown) drawLaserTrail(ctx, trail, at ?? trail.at(-1)!.t, c.width, c.height, color);
    };
    move(clock.now());
    return clock.subscribe(move);
  }, [slides, clock]);
  return (
    <>
      <canvas ref={trailCanvas} className="tt-laser-trail" aria-hidden="true" />
      <div ref={el} className="tt-laser" data-on="false" aria-hidden="true">
        <span />
      </div>
    </>
  );
}

/**
 * Keep a canvas's backing store at its size in device pixels: `device-pixel-content-box` where the browser has it
 * (Chrome, Firefox), else the CSS size × devicePixelRatio. Zoom and display moves resize the device-pixel box.
 */
function useDevicePixels(ref: RefObject<HTMLCanvasElement | null>): void {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const device = entry.devicePixelContentBoxSize?.[0];
      const css = entry.contentBoxSize?.[0];
      const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
      const w = device ? device.inlineSize : Math.round((css?.inlineSize ?? entry.contentRect.width) * dpr);
      const h = device ? device.blockSize : Math.round((css?.blockSize ?? entry.contentRect.height) * dpr);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
    });
    try {
      ro.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      ro.observe(canvas);
    }
    return () => ro.disconnect();
  }, [ref]);
}

import { type CSSProperties, type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import type { Region } from "../contracts/types";
import { dirOf } from "../viewer/lang";
import { usePlayer } from "./context";
import { useFrameValue } from "./frameClock";
import { drawInk, inkSignature, markBoxes } from "./overlays";
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
  const { tracks, prefs, slides, clock } = usePlayer();
  const slideTime = useSlideTime();
  useSyncExternalStore(slides?.subscribe ?? noop, slides?.getVersion ?? zero);
  const at = useFrameValue(clock, (t) => slides?.slideAt(slideTime(t)), sameSlide);
  const describe = tracks.describe?.enabled ? tracks.describe : undefined;
  const described = describe?.sliced?.slide;
  const lang = describe?.lang ?? "en";
  const on = at?.slide ?? null;
  const picture = on && slides ? slides.picture(on.deck, on.index) : undefined;
  const info = on && slides ? slides.deckInfo(on.deck) : undefined;
  const aspect = info?.aspect ?? (picture ? picture.image.width / picture.image.height : 16 / 9);
  const runs = picture?.image.runs ?? [];
  const marks: Mark[] = on
    ? (at?.marks ?? []).flatMap(({ data }) =>
        markBoxes(data.span, runs).map((box, i) => ({ id: `${data.id}:${i}`, style: data.style, color: data.color, box })),
      )
    : [];
  const label = on ? `Slide ${on.index + 1}` : "Slides";
  const description = described && prefs.describe !== "off" ? described.description : undefined;

  return (
    <SourceTile
      kind="slides"
      aspect={aspect}
      label={label}
      overlay={
        slides && slides.isActive("slide") ? (
          <>
            <div className="tt-marks" aria-hidden="true">
              {marks.map((k) => (
                <span key={k.id} className={`tt-textmark tt-textmark-${k.style}`} style={markStyle(k)} />
              ))}
            </div>
            <InkLayer slides={slides} />
            <LaserPointer slides={slides} />
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
          data-slide={on ? on.index + 1 : undefined}
        />
      ) : (
        <div className="tt-slide">
          <span className="tt-slide-eyebrow">Slides</span>
          <strong className="tt-slide-title">{slideTitle()}</strong>
          {description ? (
            <p className="tt-slide-description" lang={lang} dir={dirOf(lang)}>
              {description}
            </p>
          ) : (
            <p className="tt-slide-hint">{hint()}</p>
          )}
        </div>
      )}
      {picture && description ? (
        <p className="tt-slide-caption" lang={lang} dir={dirOf(lang)}>
          {description}
        </p>
      ) : null}
    </SourceTile>
  );

  function slideTitle(): string {
    if (on) return `Slide ${on.index + 1}`;
    if (described) return `Slide ${described.id + 1}`;
    return at ? "No slide shown" : "Slides appear here";
  }

  function hint(): string {
    if (on) return "Loading the slide…";
    if (at) return "The speaker is not showing a slide right now.";
    if (tracks.describe && prefs.describe === "off")
      return "Turn on slide descriptions in Settings to follow the slides as text.";
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
 * strokes visible at the frame's time change (a point, a stroke, an erase) or the size does. While the group at
 * the playhead loads, the last drawing stays.
 */
function InkLayer({ slides }: { slides: SlideTracks }) {
  const { clock } = usePlayer();
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
      const strokes = slides.inkAt(time.current(t));
      if (!strokes) return;
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
  }, [slides, clock]);
  return <canvas ref={canvas} className="tt-ink" aria-hidden="true" />;
}

/**
 * The laser (decision 0020): one element the size of the slide, translated by the pointer's fractions on the
 * compositor (a percentage of its own size is a fraction of the slide), shown only while the laser is on.
 */
function LaserPointer({ slides }: { slides: SlideTracks }) {
  const { clock } = usePlayer();
  const slideTime = useSlideTime();
  const el = useRef<HTMLDivElement>(null);
  const time = useRef(slideTime);
  useEffect(() => {
    time.current = slideTime;
  });
  useEffect(() => {
    const d = el.current;
    if (!d) return;
    let last = "";
    const move = (t: number | undefined) => {
      const p = slides.pointerAt(time.current(t));
      const key = p ? `${p.x.toFixed(4)},${p.y.toFixed(4)}` : "off";
      if (key === last) return;
      last = key;
      d.dataset.on = p ? "true" : "false";
      if (p) d.style.transform = `translate(${p.x * 100}%, ${p.y * 100}%)`;
    };
    move(clock.now());
    return clock.subscribe(move);
  }, [slides, clock]);
  return (
    <div ref={el} className="tt-laser" data-on="false" aria-hidden="true">
      <span />
    </div>
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

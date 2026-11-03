import { useEffect, useRef, useState } from "react";
import { Link } from "../../router";
import { Art } from "./Art";
import { PlayIcon } from "./icons";
import type { HubItem } from "./items";
import { AlsoLink, Named, PRELOAD_WATCH, playLabel, watchHref } from "./Tile";

/** How long the hero shows one talk before the next, ms (not under reduced motion, nor while pointed at). */
export const HERO_CYCLE_MS = 9_000;

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The hero: what is on air now, full width, with its key art, its words and its two ways in. With several on air it
 * moves on every few seconds; the dots pick one.
 */
export function Hero({ items, paused = false }: { items: HubItem[]; paused?: boolean }) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const root = useRef<HTMLElement>(null);
  const count = items.length;
  const at = count ? index % count : 0;
  const item = items[at];

  useEffect(() => {
    if (count < 2 || held || paused || reducedMotion()) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % count), HERO_CYCLE_MS);
    return () => window.clearTimeout(t);
  }, [count, held, paused, at]);

  if (!item) return null;
  const play = playLabel(item);
  return (
    <section
      ref={root}
      className="hero"
      aria-roledescription="carousel"
      aria-label="On now"
      data-kind={item.kind}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      <div className="hero-backdrop" key={item.room} aria-hidden="true">
        <Art art={item.art} seed={item.room} className="hero-art" />
      </div>
      <div className="hero-lanes-light" aria-hidden="true" />
      <div className="hero-inner">
        <div className="hero-copy" key={item.room} aria-live={held ? "polite" : "off"}>
          <p className="hero-eyebrow">
            {item.onAir ? (
              <span className="hub-badge hub-badge-live hero-live">
                <span className="hub-live-dot" aria-hidden="true" />
                LIVE NOW
              </span>
            ) : (
              <span className="hub-badge hub-badge-glass">Live session</span>
            )}
            {item.subject ? <span className="hero-subject">{item.subject}</span> : null}
          </p>
          <h2 className="hero-title">{item.title}</h2>
          <p className="hero-meta">
            {[
              item.speaker,
              item.minutes ? `${item.minutes} min` : undefined,
              item.spoken?.name,
              item.subtitleLanguages ? `subtitles in ${item.subtitleLanguages} languages` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {item.description ? <p className="hero-desc">{item.description}</p> : null}
          <div className="hero-actions">
            <Link href={watchHref(item.room)} className="hub-btn hub-btn-play" {...PRELOAD_WATCH}>
              <PlayIcon />
              <Named label={play} title={item.title} />
            </Link>
            <AlsoLink item={item} className="hub-btn hub-btn-glass" />
          </div>
        </div>
        <TrackLanes item={item} />
      </div>
      {count > 1 ? (
        <div className="hero-dots" role="group" aria-label="Pick a talk">
          {items.map((it, i) => (
            <button
              key={it.room}
              type="button"
              className="hero-dot"
              aria-label={`Show ${it.title}`}
              aria-current={i === at ? "true" : undefined}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The idea of the product, drawn: the talk on one lane and its AI tracks arriving on theirs, up to the live edge. */
function TrackLanes({ item }: { item: HubItem }) {
  const lanes = [
    { name: "Speaker", kind: "media" },
    { name: "Captions", kind: "text" },
    { name: "Translations", kind: "text" },
    { name: "Slide descriptions", kind: "slides" },
    { name: "Chapters", kind: "marks" },
  ] as { name: string; kind: string; lang?: string }[];
  return (
    <div className="hero-tracks" aria-hidden="true">
      <div className="hero-tracks-head">
        <span>Tracks in this talk</span>
        <span className="hero-tracks-edge">{item.kind === "recording" ? "Recorded" : "Live edge"}</span>
      </div>
      <ol className="hero-tracks-list">
        {lanes.map((lane, i) => (
          <li key={lane.name} className="hero-lane" data-lane={lane.kind} style={{ ["--i" as string]: i }}>
            <span className="hero-lane-name" lang={lane.lang}>
              {lane.name}
            </span>
            <span className="hero-lane-strip">
              <span className="hero-lane-clips" />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

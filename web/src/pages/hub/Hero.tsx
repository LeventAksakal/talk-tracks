import { useEffect, useRef, useState } from "react";
import { Link } from "../../router";
import { stillCredit } from "../demoRooms";
import { PlayIcon } from "./icons";
import type { HubItem } from "./items";
import { Still } from "./Still";
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

/** A title and its subtitle, split at the first colon: "You Are Part Virus" over "How Biological Viruses Hack Cells". */
export function splitTitle(title: string): [string, string | undefined] {
  const at = title.indexOf(": ");
  return at > 0 ? [title.slice(0, at), title.slice(at + 2)] : [title, undefined];
}

/** What the talk carries, in words: "Spoken in English · subtitles in any of 50 languages · chapters, …". */
function tracksLine(item: HubItem): string {
  const rest = item.tracks.filter((t) => t !== "Captions" && t !== "Translations").map((t) => t.toLowerCase());
  const others = rest.length > 1 ? `${rest.slice(0, -1).join(", ")} and ${rest.at(-1)}` : rest[0];
  return [
    item.spoken ? `Spoken in ${item.spoken.name}` : "Captions",
    item.subtitleLanguages ? `subtitles in any of ${item.subtitleLanguages} languages` : undefined,
    others,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The hero: what is on air now. The talk's still from its own recording on one side, credited under it; its title,
 * speaker, what it is about and its two ways in on the other. With several on air it moves on every few seconds;
 * the markers under the still pick one.
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
  const [title, subtitle] = splitTitle(item.title);
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
      <div className="hero-copy" key={item.room} aria-live={held ? "polite" : "off"}>
        <h2 className="hero-title">
          <span className="hero-title-main">{title}</span>
          {subtitle ? (
            <>
              <span className="sr-only">: </span>
              <span className="hero-title-sub">{subtitle}</span>
            </>
          ) : null}
        </h2>
        <p className="hero-meta">
          {item.onAir ? (
            <span className="hero-live">
              <span className="hub-live-dot" aria-hidden="true" />
              Live now
            </span>
          ) : (
            <span className="hero-session">{item.kind === "recording" ? "Recording" : "Live session"}</span>
          )}
          {[item.speaker, item.subject, item.minutes ? `${item.minutes} min` : undefined]
            .filter(Boolean)
            .map((part) => (
              <span key={part}>{part}</span>
            ))}
        </p>
        {item.description ? <p className="hero-desc">{item.description}</p> : null}
        <p className="hero-tracks">{tracksLine(item)}</p>
        <div className="hero-actions">
          <Link href={watchHref(item.room)} className="hub-btn hub-btn-play" {...PRELOAD_WATCH}>
            <PlayIcon />
            <Named label={play} title={item.title} />
          </Link>
          <AlsoLink item={item} className="hub-btn hub-btn-quiet" />
        </div>
      </div>
      <figure className="hero-figure">
        <div className="hero-frame" key={item.room}>
          <Still item={item} sizes="(min-width: 960px) 56vw, 100vw" eager={at === 0} className="hero-still" />
        </div>
        <figcaption className="hero-caption">
          <span className="hero-credit">
            {item.still && item.speaker ? stillCredit(item.still, item.speaker) : null}
          </span>
          {count > 1 ? (
            <span className="hero-dots" role="group" aria-label="Pick a talk">
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
            </span>
          ) : null}
        </figcaption>
      </figure>
    </section>
  );
}

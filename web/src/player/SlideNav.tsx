import { useEffect, useRef, useState } from "react";
import "./slideNav.css";
import { Icon } from "./icons";
import { goTo, type NavRange, type SlideRef, step, stepKey } from "./deckNav";
import type { SlideTracks } from "./slideTracks";
import { isTyping } from "./typing";

/**
 * The slide tile's deck controls (deckNav.ts), top centre of the slide: back and forward, the slide in view of how many, and while the
 * listener is on a slide of their own, where the speaker (live) or the playhead (a recording, a replay, rewound) is
 * and the one button that goes back to following. ← → and PageUp/PageDown step while focus is in these controls (the
 * player's own ← → seek everywhere else). "All slides" opens a strip of the pictures the deck already holds.
 */
export function SlideNav({
  slides,
  view,
  following,
  pinned,
  range,
  count,
  live,
  onPin,
}: {
  slides: SlideTracks;
  /** The slide on the panel. */
  view: SlideRef;
  /** The slide the speaker or the playhead is on; null when they show none. */
  following: SlideRef | null;
  /** The slide the listener stays on; null while following. */
  pinned: SlideRef | null;
  range: NavRange | undefined;
  /** Slides in the deck, when known. */
  count: number | undefined;
  /** Live: the button follows the speaker; otherwise it matches the playhead. */
  live: boolean;
  onPin: (pin: SlideRef | null) => void;
}) {
  const [strip, setStrip] = useState(false);
  const go = (next: SlideRef | null | undefined) => {
    if (next !== undefined) onPin(next);
  };
  const back = step(view, -1, range, following);
  const ahead = step(view, 1, range, following);
  // A native listener on this element: Media Chrome's controller (an ancestor) and the player's shortcuts (on the
  // document) seek with the arrows, and both would see the key before a React handler at the root.
  const root = useRef<HTMLDivElement>(null);
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    onKey.current = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTyping(e)) return;
      const by = stepKey(e.key);
      if (by === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      go(step(view, by, range, following));
    };
  });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const fn = (e: KeyboardEvent) => onKey.current(e);
    el.addEventListener("keydown", fn);
    return () => el.removeEventListener("keydown", fn);
  }, []);
  const total = count ?? (range ? range.last + 1 : undefined);
  const where = `Slide ${view.index + 1}${total ? ` of ${total}` : ""}`;
  const who = live ? "speaker" : "playhead";
  const theirs = following
    ? following.index === view.index
      ? `${who} here too`
      : `${who} on ${following.index + 1}`
    : live
      ? "speaker shows no slide"
      : "no slide at the playhead";

  return (
    <div
      className="tt-slide-nav"
      data-pinned={pinned ? "" : undefined}
      data-strip={strip ? "" : undefined}
      ref={root}
      // A click or double-click here is not one on the stage (play/pause, full screen).
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div
        className="tt-slide-nav-bar"
        role="toolbar"
        aria-label="Slides"
        aria-keyshortcuts="ArrowLeft ArrowRight PageUp PageDown"
      >
        <button
          type="button"
          className="tt-slide-nav-step"
          aria-label="Previous slide"
          title="Previous slide (←)"
          disabled={back === undefined}
          onClick={() => go(back)}
        >
          <Icon name="chevronLeft" />
        </button>
        <span className="tt-slide-nav-where" aria-live="polite">
          {where}
          {pinned ? <span className="tt-slide-nav-theirs"> · {theirs}</span> : null}
        </span>
        <button
          type="button"
          className="tt-slide-nav-step"
          aria-label="Next slide"
          title="Next slide (→)"
          disabled={ahead === undefined}
          onClick={() => go(ahead)}
        >
          <Icon name="forward" />
        </button>
        {range && range.last > range.first ? (
          <button
            type="button"
            className="tt-slide-nav-all"
            aria-expanded={strip}
            title={strip ? "Hide the slide strip" : "Every slide of the deck"}
            onClick={() => setStrip((s) => !s)}
          >
            All slides
          </button>
        ) : null}
        {pinned ? (
          <button type="button" className="tt-slide-nav-follow" onClick={() => onPin(null)}>
            {live ? "Follow the speaker" : "Match the playhead"}
          </button>
        ) : null}
      </div>
      {strip && range ? (
        <ol className="tt-slide-strip" aria-label="All slides">
          {indexes(range).map((i) => {
            const picture = slides.picture(view.deck, i);
            const here = i === view.index;
            return (
              <li key={i}>
                <button
                  type="button"
                  className="tt-slide-thumb"
                  aria-current={here ? "true" : undefined}
                  aria-label={`Slide ${i + 1}${following?.index === i ? `, the ${who} is here` : ""}`}
                  data-theirs={following?.index === i ? "" : undefined}
                  onClick={() => go(goTo(view, i, range, following))}
                >
                  {picture ? <img src={picture.url} alt="" draggable={false} /> : <span>{i + 1}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

function indexes(range: NavRange): number[] {
  const out: number[] = [];
  for (let i = range.first; i <= range.last; i++) out.push(i);
  return out;
}

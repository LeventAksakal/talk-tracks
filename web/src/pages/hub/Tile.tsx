import { useId } from "react";
import { Link } from "../../router";
import { preloadWatch } from "../../routes";
import { Art } from "./Art";
import { LiveIcon, PlayIcon, RestartIcon } from "./icons";
import type { HubItem } from "./items";

/** A card's link starts loading the watch page when it is hovered or focused, before the click. */
export const PRELOAD_WATCH = { onMouseEnter: preloadWatch, onFocus: preloadWatch } as const;

export const watchHref = (room: string) => `/watch/${room}`;

/** What the card's one main action says, by what it opens. */
export function playLabel(item: HubItem): string {
  if (item.kind === "recording") return "Play";
  if (item.onAir === false) return "Open";
  return "Watch live";
}

/**
 * A link's words: what it does, seen, then the talk's title for assistive tech only. The accessible name starts
 * with the visible words (WCAG 2.5.3), so "Watch live" names it for voice control too.
 */
export function Named({ label, title }: { label: string; title: string }) {
  return (
    <>
      {label}
      <span className="sr-only">: {title}</span>
    </>
  );
}

/** The other version of a demo lecture, as a link. */
export function AlsoLink({ item, className }: { item: HubItem; className?: string }) {
  if (!item.also) return null;
  const toRecording = item.also.kind === "recording";
  return (
    <Link href={watchHref(item.also.room)} className={className} {...PRELOAD_WATCH}>
      {toRecording ? <RestartIcon /> : <LiveIcon />}
      <Named label={toRecording ? "From the start" : "Live session"} title={item.title} />
    </Link>
  );
}

/** LIVE when the relay has the room on air; a quieter word for a live session between runs. */
export function OnAirBadge({ item }: { item: HubItem }) {
  if (item.kind === "recording")
    return <span className="hub-badge hub-badge-rec">{item.minutes ? `${item.minutes} min` : "Recording"}</span>;
  if (item.onAir)
    return (
      <span className="hub-badge hub-badge-live">
        <span className="hub-live-dot" aria-hidden="true" />
        LIVE
      </span>
    );
  if (item.onAir === false)
    return <span className="hub-badge hub-badge-off">{item.kind === "live" ? "Starting again soon" : "Off air"}</span>;
  return null;
}

/**
 * A glass card. Hovered or focused, it widens into its extended view: the description, the speaker, the languages
 * and tracks it carries, and its play button. The whole card opens the room; keyboard focus lands on the play
 * button (the card's one main action), which also opens the extended view.
 */
export function Tile({ item }: { item: HubItem }) {
  const titleId = useId();
  const play = playLabel(item);
  return (
    <li className="tile" data-kind={item.kind} data-on-air={item.onAir === undefined ? undefined : String(item.onAir)}>
      <article className="tile-card" aria-labelledby={titleId} onMouseEnter={preloadWatch}>
        <div className="tile-face">
          <div className="tile-art">
            <Art art={item.art} seed={item.room} className="tile-art-img" />
            <OnAirBadge item={item} />
          </div>
          <div className="tile-head">
            {item.subject ? <p className="tile-eyebrow">{item.subject}</p> : null}
            <h3 className="tile-title" id={titleId}>
              {item.title}
            </h3>
            {item.speaker ? <p className="tile-speaker">{item.speaker}</p> : null}
          </div>
        </div>
        <div className="tile-more">
          {item.description ? <p className="tile-desc">{item.description}</p> : null}
          <dl className="tile-facts">
            {item.spoken ? (
              <div>
                <dt>Spoken in</dt>
                <dd className="tile-chips">
                  <span lang={item.spoken.code} className="tile-chip">
                    {item.spoken.name}
                  </span>
                </dd>
              </div>
            ) : null}
            {item.subtitleLanguages ? (
              <div>
                <dt>Subtitles</dt>
                <dd>Any of {item.subtitleLanguages} languages, translated when you pick one</dd>
              </div>
            ) : null}
            <div>
              <dt>Tracks</dt>
              <dd className="tile-tracks">{item.tracks.join(" · ")}</dd>
            </div>
          </dl>
          <div className="tile-actions">
            <Link href={watchHref(item.room)} className="tile-play" {...PRELOAD_WATCH}>
              <PlayIcon />
              <Named label={play} title={item.title} />
            </Link>
            <AlsoLink item={item} className="tile-also" />
          </div>
          {item.credit ? <p className="tile-credit">{item.credit}</p> : null}
        </div>
      </article>
    </li>
  );
}

/** A placeholder card while a row loads. */
export function TileSkeleton() {
  return (
    <li className="tile tile-skeleton" aria-hidden="true">
      <div className="tile-card">
        <div className="tile-face">
          <div className="tile-art" />
          <div className="tile-head">
            <span className="skeleton-line" />
            <span className="skeleton-line skeleton-short" />
          </div>
        </div>
      </div>
    </li>
  );
}

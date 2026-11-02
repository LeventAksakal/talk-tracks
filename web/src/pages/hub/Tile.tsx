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
export function playLabel(item: HubItem): { short: string; name: string } {
  if (item.kind === "recording") return { short: "Play", name: `Play the recording of ${item.title}` };
  if (item.onAir === false)
    return {
      short: "Open",
      name: item.kind === "live" ? `Open the live session of ${item.title}` : `Open ${item.title}`,
    };
  return { short: "Watch live", name: `Watch ${item.title} live` };
}

/** The other version of a demo lecture, as a link. */
export function AlsoLink({ item, className }: { item: HubItem; className?: string }) {
  if (!item.also) return null;
  const toRecording = item.also.kind === "recording";
  return (
    <Link
      href={watchHref(item.also.room)}
      className={className}
      aria-label={toRecording ? `Play ${item.title} from the start` : `Watch the live session of ${item.title}`}
      {...PRELOAD_WATCH}
    >
      {toRecording ? <RestartIcon /> : <LiveIcon />}
      {toRecording ? "From the start" : "Live session"}
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
            {item.languages.length ? (
              <div>
                <dt>Languages</dt>
                <dd className="tile-chips">
                  {item.languages.map((l) => (
                    <span key={l.code} lang={l.code} className="tile-chip">
                      {l.name}
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Tracks</dt>
              <dd className="tile-tracks">{item.tracks.join(" · ")}</dd>
            </div>
          </dl>
          <div className="tile-actions">
            <Link href={watchHref(item.room)} className="tile-play" aria-label={play.name} {...PRELOAD_WATCH}>
              <PlayIcon />
              {play.short}
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

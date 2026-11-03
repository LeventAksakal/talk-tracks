import { useId } from "react";
import { Link } from "../../router";
import { preloadWatch } from "../../routes";
import { LiveIcon, PlayIcon, RestartIcon } from "./icons";
import { type HubItem, splitTitle } from "./items";
import { Still } from "./Still";

/** A card's link starts loading the watch page when it is hovered or focused, before the click. */
export const PRELOAD_WATCH = { onMouseEnter: preloadWatch, onFocus: preloadWatch } as const;

export const watchHref = (room: string) => `/watch/${room}`;

/**
 * What the card's one main action says, by what it opens. A demo lecture's live session is "Watch live" between its
 * runs too (the player says when the next starts), so the words and the button's width never change under the reader.
 */
export function playLabel(item: HubItem): string {
  if (item.kind === "recording") return "Play";
  if (item.onAir === false && item.kind !== "live") return "Open";
  return "Watch live";
}

/** The tracks beyond subtitles, in a sentence: "Slide descriptions, chapters and glossary". */
export function extraTracks(item: HubItem): string | undefined {
  const rest = item.tracks.filter((t) => t !== "Captions" && t !== "Translations").map((t) => t.toLowerCase());
  if (!rest.length) return undefined;
  const list = rest.length > 1 ? `${rest.slice(0, -1).join(", ")} and ${rest.at(-1)}` : rest[0]!;
  return list.charAt(0).toUpperCase() + list.slice(1);
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
      <Named label={toRecording ? "From the start" : "Live replay"} title={item.title} />
    </Link>
  );
}

/**
 * A recording's length, on its still; LIVE on a talk that is on air, where the row does not already say so; a quieter
 * word for a live session between runs.
 */
export function OnAirBadge({ item, live = true }: { item: HubItem; live?: boolean }) {
  if (item.kind === "recording")
    return item.minutes ? <span className="hub-badge hub-badge-time">{item.minutes} min</span> : null;
  if (!live) return null;
  if (item.onAir) return <span className="hub-badge hub-badge-live">LIVE</span>;
  if (item.onAir === false)
    return <span className="hub-badge hub-badge-off">{item.kind === "live" ? "Starting again soon" : "Off air"}</span>;
  return null;
}

/**
 * A card: the talk's still, its title and speaker. Hovered or focused, its extended view covers the still, the same
 * size, so nothing around it moves: what the talk is about, its language and tracks, and its play button. The whole
 * card opens the room; keyboard focus lands on the play button (the card's one main action), which also opens it.
 * The title shows its main part (before the colon) so it never breaks mid-word; the rest is read out.
 */
export function Tile({ item, live = true }: { item: HubItem; live?: boolean }) {
  const titleId = useId();
  const play = playLabel(item);
  const [main, sub] = splitTitle(item.title);
  return (
    <li className="tile" data-kind={item.kind} data-on-air={item.onAir === undefined ? undefined : String(item.onAir)}>
      <article className="tile-card" aria-labelledby={titleId} onMouseEnter={preloadWatch}>
        <div className="tile-art">
          <Still item={item} sizes="(min-width: 1200px) 340px, 288px" className="tile-art-img" />
          <OnAirBadge item={item} live={live} />
          <div className="tile-more">
            {item.description ? <p className="tile-desc">{item.description}</p> : null}
            <dl className="tile-facts">
              {item.spoken ? (
                <div>
                  <dt className="sr-only">Spoken in</dt>
                  <dd lang={item.spoken.code}>{item.spoken.name}</dd>
                </div>
              ) : null}
              {item.subtitleLanguages ? (
                <div>
                  <dt className="sr-only">Subtitles</dt>
                  <dd>
                    {item.spoken ? "subtitles" : "Subtitles"} in {item.subtitleLanguages} languages
                  </dd>
                </div>
              ) : null}
              {extraTracks(item) ? (
                <div className="tile-tracks">
                  <dt className="sr-only">Tracks</dt>
                  <dd>{extraTracks(item)}</dd>
                </div>
              ) : null}
            </dl>
            <div className="tile-actions">
              <Link href={watchHref(item.room)} className="tile-play" {...PRELOAD_WATCH}>
                <PlayIcon />
                <Named label={play} title={item.title} />
              </Link>
              <AlsoLink item={item} className="tile-also" />
            </div>
          </div>
        </div>
        <div className="tile-head">
          {/* Named by the whole title; it shows the main part, which starts the name (WCAG 2.5.3). */}
          <h3 className="tile-title" id={titleId} aria-label={sub ? item.title : undefined}>
            {main}
          </h3>
          {item.speaker ? <p className="tile-speaker">{item.speaker}</p> : null}
        </div>
      </article>
    </li>
  );
}

import { Link } from "../../router";
import { stillCredit } from "../demoRooms";
import { PlayIcon } from "./icons";
import { type HubItem, splitTitle } from "./items";
import { Still } from "./Still";
import { AlsoLink, Named, PRELOAD_WATCH, playLabel, watchHref } from "./Tile";

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
 * What kind of showing this is, honestly: a demo lecture's live session is its recording played again on air, with the
 * AI tracks made live (decision 0032), so it says "Live replay", never plain LIVE. The dot turns red once the relay
 * says it is on air; the words do not change, so the first paint holds.
 */
function Showing({ item }: { item: HubItem }) {
  if (item.kind === "recording") return <span className="hero-showing">Recording</span>;
  const word = item.kind === "live" ? "Live replay" : "Live";
  return (
    <span className="hero-showing" data-on-air={item.onAir === undefined ? undefined : String(item.onAir)}>
      <span className="hero-showing-dot" aria-hidden="true" />
      {word}
      {item.onAir ? <span className="sr-only">, on air now</span> : null}
      {item.onAir === false ? <span className="hero-showing-off"> · starts again soon</span> : null}
    </span>
  );
}

/**
 * The hero: one demo lecture's live session, the first, always (so the first paint is the page). Its still from its
 * own recording on one side, credited under it; its title, speaker, what it is about and its two ways in on the other.
 * The other lectures' sessions are the Live now row, so no talk shows twice as a live session (decision 0036).
 */
export function Hero({ item, note }: { item: HubItem | undefined; note?: string }) {
  if (!item) return null;
  const play = playLabel(item);
  const [title, subtitle] = splitTitle(item.title);
  return (
    <section className="hero" aria-label="Featured talk" data-kind={item.kind}>
      <div className="hero-copy">
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
          <Showing item={item} />
          {[item.speaker, item.subject].filter(Boolean).map((part) => (
            <span key={part}>{part}</span>
          ))}
        </p>
        {item.description ? <p className="hero-desc">{item.description}</p> : null}
        <p className="hero-tracks">
          {item.minutes ? `${item.minutes}-minute talk · ` : null}
          {tracksLine(item)}
        </p>
        <div className="hero-actions">
          <Link href={watchHref(item.room)} className="hub-btn hub-btn-play" {...PRELOAD_WATCH}>
            <PlayIcon />
            <Named label={play} title={item.title} />
          </Link>
          <AlsoLink item={item} className="hub-btn hub-btn-quiet" />
        </div>
        {note ? <p className="hero-note">{note}</p> : null}
      </div>
      <figure className="hero-figure">
        <div className="hero-frame">
          <Still item={item} sizes="(min-width: 960px) 56vw, 100vw" eager className="hero-still" />
        </div>
        <figcaption className="hero-caption">
          {item.still && item.speaker ? stillCredit(item.still, item.speaker) : null}
        </figcaption>
      </figure>
    </section>
  );
}

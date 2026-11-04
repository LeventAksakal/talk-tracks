import { stillSources } from "../demoRooms";
import type { HubItem } from "./items";

/**
 * A talk's picture: a frame of its own recording (decision 0036), a talk's own first slide from the archive, or, for
 * a talk that has neither, its title set on a plain field. Never generated art. Decorative, since the title beside it names the talk.
 */
export function Still({
  item,
  sizes,
  eager = false,
  className,
}: {
  item: HubItem;
  /** The img sizes attribute: how wide the slot is. */
  sizes: string;
  /** The hero's first picture is the page's largest paint: load it at once and first. */
  eager?: boolean;
  className?: string;
}) {
  if (!item.still && item.slide)
    return (
      <img
        className={`still still-slide ${className ?? ""}`}
        src={item.slide}
        width={480}
        height={270}
        alt=""
        loading={eager ? "eager" : "lazy"}
        decoding="async"
      />
    );
  if (!item.still)
    return (
      <div className={`still still-blank ${className ?? ""}`} aria-hidden="true">
        <span>{item.title}</span>
      </div>
    );
  const { src, srcSet } = stillSources(item.still);
  return (
    <img
      className={`still ${className ?? ""}`}
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      width={480}
      height={270}
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      {...(eager ? { fetchPriority: "high" as const } : {})}
    />
  );
}

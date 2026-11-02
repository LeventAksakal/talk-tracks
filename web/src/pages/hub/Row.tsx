import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ChevronIcon } from "./icons";

/**
 * A row of cards that scrolls sideways. The arrows are for a mouse without a sideways wheel; keyboard focus scrolls
 * the row by itself, so they stay out of the tab order.
 */
export function Row({
  id,
  title,
  note,
  busy,
  children,
}: {
  id: string;
  title: string;
  /** One short line beside the title. */
  note?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  const track = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [measure]);
  const page = (dir: 1 | -1) => {
    const el = track.current;
    el?.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };
  const headingId = `${id}-heading`;
  return (
    <section className="hub-row" id={id} aria-labelledby={headingId}>
      <div className="hub-row-head">
        <h2 id={headingId} className="hub-row-title">
          {title}
        </h2>
        {note ? <p className="hub-row-note">{note}</p> : null}
      </div>
      <div className="hub-row-frame">
        <button
          type="button"
          className="hub-row-arrow hub-row-arrow-start"
          aria-label={`Scroll ${title} back`}
          tabIndex={-1}
          hidden={edges.start}
          onClick={() => page(-1)}
        >
          <ChevronIcon dir="left" />
        </button>
        <ul className="hub-row-track" ref={track} aria-busy={busy || undefined}>
          {children}
        </ul>
        <button
          type="button"
          className="hub-row-arrow hub-row-arrow-end"
          aria-label={`Scroll ${title} on`}
          tabIndex={-1}
          hidden={edges.end}
          onClick={() => page(1)}
        >
          <ChevronIcon dir="right" />
        </button>
      </div>
    </section>
  );
}

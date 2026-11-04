/**
 * The slides as a deck the listener can page through (owner, 2026-11-04: "go ahead or stay on the prev. slide then hit
 * 'follow the speaker' or 'match seek head'"). Following is the default: the panel shows the slide at the playhead.
 * A step pins a slide; the panel stays on it whatever the speaker or the playhead does, until the listener follows
 * again (or steps back onto the slide the speaker is on). Nothing here fetches: the deck's pictures are already held.
 */

/** A slide of a deck. */
export interface SlideRef {
  deck: number;
  index: number;
}

/** The slides the listener can reach, by index in the deck (inclusive). */
export interface NavRange {
  first: number;
  last: number;
}

/**
 * Where the listener may go. A recording, or a playhead rewound, has the whole deck (`count` slides). Live, the
 * slides shown so far: up to the furthest the speaker has shown (`shown`) or is on now (`at`), never ahead of them.
 * Undefined when there is nothing to page through.
 */
export function navRange(o: {
  count: number | undefined;
  whole: boolean;
  shown: number | undefined;
  at: number | undefined;
}): NavRange | undefined {
  const reached = Math.max(o.shown ?? -1, o.at ?? -1);
  const last = o.whole && o.count !== undefined && o.count > 0 ? o.count - 1 : reached;
  const capped = o.count !== undefined && o.count > 0 ? Math.min(last, o.count - 1) : last;
  return capped >= 0 ? { first: 0, last: capped } : undefined;
}

/**
 * The slide pinned after going to `index` from the slide in view: null to follow again (it is the slide the speaker
 * or the playhead is on), undefined when nothing changes (out of range, or already there).
 */
export function goTo(
  view: SlideRef,
  index: number,
  range: NavRange | undefined,
  following: SlideRef | null,
): SlideRef | null | undefined {
  if (!range) return undefined;
  const target = Math.min(range.last, Math.max(range.first, index));
  if (target === view.index) return undefined;
  if (following && following.deck === view.deck && following.index === target) return null;
  return { deck: view.deck, index: target };
}

/** One step back (-1) or forward (+1) from the slide in view; see goTo. */
export function step(
  view: SlideRef,
  by: -1 | 1,
  range: NavRange | undefined,
  following: SlideRef | null,
): SlideRef | null | undefined {
  return goTo(view, view.index + by, range, following);
}

/** The keys that page the slides while the slide panel has focus: -1 back, +1 forward. */
export function stepKey(key: string): -1 | 1 | undefined {
  switch (key) {
    case "ArrowLeft":
    case "PageUp":
      return -1;
    case "ArrowRight":
    case "PageDown":
      return 1;
    default:
      return undefined;
  }
}

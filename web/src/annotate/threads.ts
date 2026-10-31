// The threads of the Discussion tab and the console's question list, at the playhead (ui-design §12): every comment posted by room time t with its
// replies, the speaker's replies first; a replay shows what had been said by then, and says how many replies came
// later. Pure, so the tab and its tests read the same thing.

import type { Comment, CommentRecord, Reply, ShowSlide } from "../contracts/types";

export type DiscussionFilter = "all" | "slide" | "questions";
export type DiscussionOrder = "newest" | "oldest";

export interface Thread {
  comment: Comment;
  /** Shown by t: the speaker's first, then in the order they were posted. */
  replies: Reply[];
  /** Replies posted after t (a replay's playhead). */
  later: number;
}

export interface ThreadQuery {
  /** The playhead's room time; undefined at the live edge (everything said so far). */
  t?: number;
  filter?: DiscussionFilter;
  /** The slide on screen, for the "This slide" filter. */
  slide?: ShowSlide | null;
  search?: string;
  order?: DiscussionOrder;
}

/** Threads from the room's comment records (commentThreads: edits applied, hidden ones gone). */
export function threadsAt(records: readonly CommentRecord[], q: ThreadQuery = {}): Thread[] {
  const by = (at: number) => q.t === undefined || at <= q.t;
  const replies = new Map<string, Reply[]>();
  for (const { data } of records) {
    if (data.kind !== "reply") continue;
    const list = replies.get(data.to) ?? [];
    list.push(data);
    replies.set(data.to, list);
  }
  const needle = q.search?.trim().toLowerCase() ?? "";
  const matches = (x: { text: string; by: { name: string } }) =>
    x.text.toLowerCase().includes(needle) || x.by.name.toLowerCase().includes(needle);
  const out: Thread[] = [];
  for (const { data } of records) {
    if (data.kind !== "comment" || !by(data.at)) continue;
    if (q.filter === "questions" && !data.question) continue;
    if (q.filter === "slide" && (!q.slide || data.anchor.deck !== q.slide.deck || data.anchor.index !== q.slide.index))
      continue;
    const all = replies.get(data.id) ?? [];
    const shown = all
      .filter((r) => by(r.at))
      .sort((a, b) => Number(b.by.speaker === true) - Number(a.by.speaker === true) || a.at - b.at);
    if (needle && !matches(data) && !shown.some(matches)) continue;
    out.push({ comment: data, replies: shown, later: all.length - shown.length });
  }
  out.sort((a, b) => (q.order === "oldest" ? a.comment.at - b.comment.at : b.comment.at - a.comment.at));
  return out;
}

/** Where a comment points, in words: a part of the slide, some of its text, or the whole slide. */
export function anchorLabel(c: Comment): string {
  const slide = `Slide ${c.anchor.index + 1}`;
  if (c.anchor.span?.length) return `${slide}, text`;
  if (c.anchor.region) return `${slide}, area`;
  return slide;
}

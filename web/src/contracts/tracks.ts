// Carry-ins and state of the speaker's and the room's event tracks (ui-design §3.4), the same rules as
// agents/src/talk_tracks/records.py (both are checked against contracts/examples/carry-ins.json).
//
// Each function takes records in publication order and returns what is in effect after them. That is
// object 0 of the next slice (for a publisher), and the state at time t (for the player): pass the
// records of the group ⌊t/4000⌋ up to t, see `upTo`. Seeking never needs an earlier group.
//
// Publisher rules that keep one group enough: when a slide is shown, the console re-sends the slide's
// strokes as `stroke` records, and the room service re-sends its threads (comment, then replies, with
// their current text), each with m = that moment.

import type {
  Anchor,
  Comment,
  CommentRecord,
  CurrentSlideRecord,
  InkClear,
  InkRecord,
  InkStroke,
  ShowSlide,
} from "./types";

/** A slice's records in order (object 0 first), keeping those that took effect by room time t. */
export function upTo<R extends { m: number }>(objects: readonly (readonly R[])[], t: number): R[] {
  return objects.flat().filter((r) => r.m <= t);
}

/** Carry-in of the slide, pointer and room tracks: their last record, the state still in effect. */
export function lastRecord<R>(records: readonly R[]): R[] {
  return records.slice(-1);
}

/** The slide on screen after these records; null when none is shown. */
export function currentSlide(records: Iterable<CurrentSlideRecord>): ShowSlide | null {
  let shown: ShowSlide | null = null;
  for (const r of records) shown = r.data.kind === "show" ? r.data : null;
  return shown;
}

export type StrokeRecord = { m: number; data: InkStroke };

const onSlide = (where: InkStroke | InkClear | Anchor, slide: InkClear | ShowSlide) =>
  where.deck === slide.deck && where.index === slide.index;

/**
 * Every stroke still on some slide after these records, by id, as a whole `stroke` record whose m is
 * when it appeared. Points, end or erase of a stroke never seen are ignored.
 */
export function inkStrokes(records: Iterable<InkRecord>): Map<string, StrokeRecord> {
  let strokes = new Map<string, StrokeRecord>();
  for (const { m, data: d } of records) {
    switch (d.kind) {
      case "begin":
        strokes.set(d.stroke, { m, data: { ...d, kind: "stroke", done: false } });
        break;
      case "stroke":
        strokes.set(d.stroke, { m, data: d });
        break;
      case "points":
      case "end": {
        const seen = strokes.get(d.stroke);
        if (!seen) break;
        const data =
          d.kind === "points"
            ? { ...seen.data, points: [...seen.data.points, ...d.points] }
            : { ...seen.data, done: true };
        strokes.set(d.stroke, { m: seen.m, data });
        break;
      }
      case "erase":
        for (const id of d.strokes) strokes.delete(id);
        break;
      case "clear":
        strokes = new Map([...strokes].filter(([, s]) => !onSlide(s.data, d)));
        break;
    }
  }
  return strokes;
}

/** Carry-in of the ink track, or the ink to draw: the strokes on the slide on screen, oldest first. */
export function inkCarry(records: Iterable<InkRecord>, on: ShowSlide | null): StrokeRecord[] {
  if (!on) return [];
  return [...inkStrokes(records).values()].filter((s) => onSlide(s.data, on)).sort((a, b) => a.m - b.m);
}

/**
 * Every comment and reply still shown after these records, edits applied and hidden ones (with a
 * hidden comment's replies) left out, in the order they were made. A reply to a comment not shown is
 * dropped.
 */
export function commentThreads(records: Iterable<CommentRecord>): CommentRecord[] {
  let shown = new Map<string, CommentRecord>();
  for (const r of records) {
    const d = r.data;
    if (d.kind === "comment" || (d.kind === "reply" && shown.get(d.to)?.data.kind === "comment")) {
      shown.set(d.id, r);
    } else if (d.kind === "edit") {
      const seen = shown.get(d.id);
      if (seen) shown.set(d.id, { ...seen, data: { ...seen.data, text: d.text } as CommentRecord["data"] });
    } else if (d.kind === "hide") {
      shown = new Map([...shown].filter(([id, v]) => id !== d.id && replyTo(v) !== d.id));
    }
  }
  return [...shown.values()];
}

/** Carry-in of the comments track, or the threads to mark: those anchored on the slide on screen. */
export function commentsCarry(records: Iterable<CommentRecord>, on: ShowSlide | null): CommentRecord[] {
  if (!on) return [];
  const threads = commentThreads(records);
  const anchored = new Set(
    threads
      .filter((r): r is { m: number; data: Comment } => r.data.kind === "comment" && onSlide(r.data.anchor, on))
      .map((r) => r.data.id),
  );
  return threads.filter((r) => anchored.has(r.data.id) || anchored.has(replyTo(r) ?? ""));
}

const replyTo = (r: CommentRecord) => (r.data.kind === "reply" ? r.data.to : undefined);

// Carry-ins and state of the speaker's and the room's event tracks (ui-design §3.4, decision 0021,
// wiki/design/container-formats.md), the same rules as agents/src/talk_tracks/records.py (both are
// checked against contracts/examples/carry-ins.json).
//
// Each function takes records of one track in publication order and returns what is in effect after
// them. That is object 0 of the next slice (for a publisher), and the state at time t (for the player):
// pass the records of the group ⌊t/4000⌋ up to t, see `upTo`. Seeking never needs an earlier group.
//
// Publisher rules that keep one group enough: when a slide is shown, the console re-sends the slide's
// strokes and marks as `stroke` and `mark` records, and the room service re-sends its threads (comment,
// then replies, with their current text) and everyone else's strokes and marks, each with m = that
// moment.
//
// The deck's annotation state is the union of the speaker's track and the room service's track of the
// same kind (talk/<room>/slides and talk/<room>/annotations `ink`, `marks`): reduce each on its own and
// draw both. A record changes only its own track, and only what its author may change (mayChange).

import {
  mayChange,
  type Anchor,
  type Comment,
  type CommentRecord,
  type CurrentSlideRecord,
  type InkClear,
  type InkRecord,
  type InkStroke,
  type MarkRecord,
  type MarksClear,
  type Reply,
  type ShowSlide,
  type TextMark,
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
export type TextMarkRecord = { m: number; data: TextMark };

const onSlide = (where: InkStroke | TextMark | Anchor, slide: InkClear | MarksClear | ShowSlide) =>
  where.deck === slide.deck && where.index === slide.index;

/**
 * Every stroke still on some slide after these records (of one ink track), by id, as a whole `stroke`
 * record whose m is when it appeared. Points, end or erase of a stroke never seen are ignored, and so
 * are erase and clear of strokes their author may not change.
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
        for (const id of d.strokes) {
          const seen = strokes.get(id);
          if (seen && mayChange(d.by, seen.data.by)) strokes.delete(id);
        }
        break;
      case "clear":
        strokes = new Map([...strokes].filter(([, s]) => !(onSlide(s.data, d) && mayChange(d.by, s.data.by))));
        break;
    }
  }
  return strokes;
}

/** Carry-in of an ink track, or the ink to draw: the strokes on the slide on screen, oldest first. */
export function inkCarry(records: Iterable<InkRecord>, on: ShowSlide | null): StrokeRecord[] {
  if (!on) return [];
  return [...inkStrokes(records).values()].filter((s) => onSlide(s.data, on)).sort((a, b) => a.m - b.m);
}

/**
 * Every text mark still on some slide after these records (of one marks track), by id, with the m of
 * when it appeared. Unmark and clear apply only to marks their author may change.
 */
export function textMarks(records: Iterable<MarkRecord>): Map<string, TextMarkRecord> {
  let marks = new Map<string, TextMarkRecord>();
  for (const { m, data: d } of records) {
    switch (d.kind) {
      case "mark":
        marks.set(d.id, { m, data: d });
        break;
      case "unmark":
        for (const id of d.marks) {
          const seen = marks.get(id);
          if (seen && mayChange(d.by, seen.data.by)) marks.delete(id);
        }
        break;
      case "clear":
        marks = new Map([...marks].filter(([, k]) => !(onSlide(k.data, d) && mayChange(d.by, k.data.by))));
        break;
    }
  }
  return marks;
}

/** Carry-in of a marks track, or the marks to draw: those on the slide on screen, oldest first. */
export function marksCarry(records: Iterable<MarkRecord>, on: ShowSlide | null): TextMarkRecord[] {
  if (!on) return [];
  return [...textMarks(records).values()].filter((k) => onSlide(k.data, on)).sort((a, b) => a.m - b.m);
}

type PostedRecord = { m: number; data: Comment | Reply };

/**
 * Every comment and reply still shown after these records, edits applied and hidden ones (with a
 * hidden comment's replies) left out, in the order they were made. A reply to a comment not shown is
 * dropped; an edit by anyone but the author, or a hide by anyone but the author or the speaker, is
 * ignored.
 */
export function commentThreads(records: Iterable<CommentRecord>): CommentRecord[] {
  let shown = new Map<string, PostedRecord>();
  for (const { m, data: d } of records) {
    if (d.kind === "comment" || (d.kind === "reply" && shown.get(d.to)?.data.kind === "comment")) {
      shown.set(d.id, { m, data: d });
    } else if (d.kind === "edit") {
      const seen = shown.get(d.id);
      if (seen && seen.data.by.id === d.by.id) shown.set(d.id, { ...seen, data: { ...seen.data, text: d.text } });
    } else if (d.kind === "hide") {
      const seen = shown.get(d.id);
      if (seen && mayChange(d.by, seen.data.by)) {
        shown = new Map([...shown].filter(([id, v]) => id !== d.id && replyTo(v) !== d.id));
      }
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

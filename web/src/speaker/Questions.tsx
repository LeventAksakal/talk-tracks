// The speaker's question list (ui-design §12, decision 0024): the room's threads from the room service, questions
// first, with reply and hide. The console's session is the speaker's (its relay token), so a reply carries
// `by.speaker` (shown first in every player) and hide removes anyone's comment.

import { useState, useSyncExternalStore } from "react";
import type { RoomService } from "../annotate/client";
import { anchorLabel, threadsAt } from "../annotate/threads";
import type { Comment } from "../contracts/types";

const noop = () => () => {};
const zero = () => 0;

/** The open questions per slide of the deck (index → count), for the counts on the console's slide strip. */
export function useQuestionCounts(service: RoomService | undefined, deck: number | undefined): Map<number, number> {
  useSyncExternalStore(service?.subscribe ?? noop, service ? service.version : zero);
  const counts = new Map<number, number>();
  if (!service || deck === undefined || service.status() !== "open") return counts;
  for (const t of threadsAt(service.threads(), { filter: "questions" })) {
    if (t.comment.anchor.deck !== deck) continue;
    counts.set(t.comment.anchor.index, (counts.get(t.comment.anchor.index) ?? 0) + 1);
  }
  return counts;
}

export function Questions({
  service,
  slide,
  onSlide,
}: {
  service: RoomService | undefined;
  /** The slide on screen (0-based), for "This slide". */
  slide: { deck: number; index: number } | undefined;
  /** Show the slide a comment is on. */
  onSlide?: (index: number) => void;
}) {
  useSyncExternalStore(service?.subscribe ?? noop, service ? service.version : zero);
  const [all, setAll] = useState(false);
  const [here, setHere] = useState(false);
  if (!service) return null;
  const status = service.status();
  const threads = threadsAt(service.threads(), {
    filter: here ? "slide" : all ? "all" : "questions",
    slide: slide ? { kind: "show", ...slide } : null,
    order: "newest",
  }).filter((t) => !here || all || t.comment.question);

  return (
    <section className="panel questions" aria-label="Questions from the audience">
      <div className="questions-head">
        <h2 className="panel-title">{all ? "Comments" : "Questions"}</h2>
        <label className="small">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All comments
        </label>
        <label className="small">
          <input type="checkbox" checked={here} onChange={(e) => setHere(e.target.checked)} /> This slide
        </label>
      </div>
      {status !== "open" ? (
        <p className="muted small" role="status">
          {status === "refused"
            ? "The room service did not accept this speaker link."
            : "Waiting for the room service (it holds the room once you are on air)…"}
        </p>
      ) : threads.length === 0 ? (
        <p className="muted small">{all ? "No comments yet." : "No questions yet."}</p>
      ) : (
        <ol className="question-list">
          {threads.map((t) => (
            <QuestionItem
              key={t.comment.id}
              comment={t.comment}
              replies={t.replies}
              service={service}
              onSlide={onSlide}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function QuestionItem({
  comment: c,
  replies,
  service,
  onSlide,
}: {
  comment: Comment;
  replies: { id: string; text: string; by: { name: string; speaker?: boolean } }[];
  service: RoomService;
  onSlide?: (index: number) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const send = async (data: object) => {
    setError(undefined);
    try {
      await service.write("comments", data);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not sent");
      return false;
    }
  };
  return (
    <li className="question" data-question={c.question || undefined}>
      <div className="question-meta small">
        <strong>{c.by.name}</strong>
        {c.question ? <span className="question-tag">Question</span> : null}
        <button type="button" className="link-button" onClick={() => onSlide?.(c.anchor.index)}>
          {anchorLabel(c)}
        </button>
      </div>
      <p className="question-text">{c.text}</p>
      {replies.length ? (
        <ul className="question-replies small">
          {replies.map((r) => (
            <li key={r.id}>
              <strong>{r.by.speaker ? "You" : r.by.name}</strong> {r.text}
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="question-reply"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void send({ kind: "reply", to: c.id, text: text.trim() }).then((ok) => ok && setText(""));
        }}
      >
        <input
          className="question-input"
          aria-label={`Reply to ${c.by.name}`}
          placeholder="Reply"
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button type="submit" className="small-button" disabled={!text.trim()}>
          Reply
        </button>
        <button type="button" className="small-button" onClick={() => void send({ kind: "hide", id: c.id })}>
          Hide
        </button>
      </form>
      {error ? (
        <p className="small error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

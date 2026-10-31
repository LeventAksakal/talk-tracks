// The Discussion tab (ui-design §12, decision 0024): the room's threads at the playhead, filters and search, a
// composer anchored on the slide (a box or words picked with the comment tool, else the whole slide), replies and
// hide. Comments made while watching a replay go out now, at the playhead's room time (`at`), on the slide seen.

import { useEffect, useRef, useState } from "react";
import type { RoomService } from "../annotate/client";
import type { Anchor, Author, Comment, CommentRecord } from "../contracts/types";
import { mayChange } from "../contracts/types";
import { formatClock } from "../playback/timeline";
import { usePlayer } from "./context";
import { anchorLabel, type DiscussionFilter, type DiscussionOrder, type Thread, threadsAt } from "../annotate/threads";
import { useListening, useRoomService } from "./listening";

const FILTERS: [DiscussionFilter, string][] = [
  ["all", "All"],
  ["slide", "This slide"],
  ["questions", "Questions"],
];

export function Discussion() {
  const { listening, slides, at, view, seek } = usePlayer();
  const state = useListening(listening);
  useRoomService(listening?.service);
  const [filter, setFilter] = useState<DiscussionFilter>("all");
  const [order, setOrder] = useState<DiscussionOrder>("newest");
  const [search, setSearch] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const service = listening?.service;
  const live = view.timeline.mode === "live";
  const t = live ? undefined : at;
  const slide = at !== undefined ? (slides?.slideAt(at)?.slide ?? null) : null;
  const open = service?.status() === "open";
  // The room service's index of every thread; without it (not held, not reachable), the comments on this slide
  // from the comments track at the playhead.
  const records: readonly CommentRecord[] = open ? service.threads() : (slides?.commentsAt(at) ?? []);
  const threads = threadsAt(records, { t, filter, slide, search, order });
  const me = service?.me();
  const author: Author | undefined = me ? { id: me.id, name: me.name ?? "", speaker: me.speaker } : undefined;

  const focus = state?.focus;
  useEffect(() => {
    if (!focus) return;
    list.current?.querySelector(`[data-thread="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  if (!listening || !service) return null;

  return (
    <div className="tt-discussion">
      <Composer service={service} anchor={state?.anchor} fallback={slide} t={t} />
      <div className="tt-row tt-discussion-filters">
        <div className="tt-segmented" role="group" aria-label="Show">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tt-button tt-secondary tt-small"
          onClick={() => setOrder(order === "newest" ? "oldest" : "newest")}
          aria-label={order === "newest" ? "Newest first; show oldest first" : "Oldest first; show newest first"}
        >
          {order === "newest" ? "Newest" : "Oldest"}
        </button>
      </div>
      <input
        className="tt-input"
        type="search"
        aria-label="Search the discussion"
        placeholder="Search comments"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {!open ? (
        <p className="tt-muted" role="status">
          {service.status() === "refused"
            ? "The discussion is not available in this room."
            : "Connecting to the discussion… Showing the comments on this slide."}
        </p>
      ) : null}
      {threads.length === 0 ? (
        <p className="tt-muted">{t === undefined ? "No comments yet." : "No comments by this point of the talk."}</p>
      ) : (
        <ol className="tt-thread-list" ref={list} aria-label="Threads">
          {threads.map((th) => (
            <ThreadItem
              key={th.comment.id}
              thread={th}
              me={author}
              service={service}
              focused={focus === th.comment.id}
              onFocus={(id) => listening.set({ focus: id })}
              seek={seek}
              t={t}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/** A new comment: on the anchor picked with the comment tool, else the slide on screen; a question or not. */
function Composer({
  service,
  anchor,
  fallback,
  t,
}: {
  service: RoomService;
  anchor: Anchor | undefined;
  fallback: { deck: number; index: number } | null;
  t: number | undefined;
}) {
  const { listening } = usePlayer();
  const [text, setText] = useState("");
  const [question, setQuestion] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const me = service.me();
  const target: Anchor | undefined = anchor ?? (fallback ? { deck: fallback.deck, index: fallback.index } : undefined);

  useEffect(() => {
    if (anchor) box.current?.focus();
  }, [anchor]);

  if (service.status() !== "open") return null;
  if (!me?.name) {
    return (
      <form
        className="tt-discussion-name"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) service.setName(name);
        }}
      >
        <label className="tt-menu-heading" htmlFor="tt-discussion-name">
          Your name, shown with what you write
        </label>
        <div className="tt-row">
          <input
            id="tt-discussion-name"
            className="tt-input"
            value={name}
            maxLength={60}
            autoComplete="nickname"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="tt-button" disabled={!name.trim()}>
            Join
          </button>
        </div>
      </form>
    );
  }

  const post = async () => {
    if (!text.trim() || !target || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await service.write("comments", { kind: "comment", text: text.trim(), anchor: target, question }, t);
      setText("");
      setQuestion(false);
      listening?.set({ anchor: undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not posted");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tt-discussion-composer">
      <div className="tt-row tt-discussion-anchor">
        <span className="tt-muted">
          {target ? `On ${anchorLabel({ anchor: target } as Comment)}` : "No slide on screen"}
          {t !== undefined ? ` · at ${formatClock(t)} of the talk` : ""}
        </span>
        {anchor ? (
          <button
            type="button"
            className="tt-button tt-secondary tt-small"
            onClick={() => listening?.set({ anchor: undefined })}
          >
            Whole slide
          </button>
        ) : null}
      </div>
      <textarea
        ref={box}
        className="tt-input"
        rows={2}
        maxLength={2000}
        aria-label="Comment"
        placeholder={question ? "Ask the speaker" : "Add a comment"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void post();
          }
        }}
      />
      <div className="tt-row">
        <label className="tt-check">
          <input type="checkbox" checked={question} onChange={(e) => setQuestion(e.target.checked)} /> Question for the
          speaker
        </label>
        <button
          type="button"
          className="tt-button"
          onClick={() => void post()}
          disabled={!text.trim() || !target || busy}
        >
          Post
        </button>
      </div>
      {error ? (
        <p className="tt-discussion-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ThreadItem({
  thread,
  me,
  service,
  focused,
  onFocus,
  seek,
  t,
}: {
  thread: Thread;
  me: Author | undefined;
  service: RoomService;
  focused: boolean;
  onFocus: (id: string | undefined) => void;
  seek: (ms: number) => void;
  t: number | undefined;
}) {
  const { comment: c, replies, later } = thread;
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const canWrite = service.status() === "open" && Boolean(me?.name);

  const send = async (data: object) => {
    setError(undefined);
    try {
      await service.write("comments", data, data && "text" in data ? t : undefined);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not sent");
      return false;
    }
  };

  return (
    <li
      className="tt-thread"
      data-thread={c.id}
      data-focus={focused || undefined}
      data-question={c.question || undefined}
      onMouseEnter={() => onFocus(c.id)}
      onMouseLeave={() => onFocus(undefined)}
    >
      <div className="tt-thread-head">
        <strong>{c.by.name}</strong>
        {c.by.speaker ? <span className="tt-tag">Speaker</span> : null}
        {c.question ? <span className="tt-tag tt-tag-question">Question</span> : null}
        <button
          type="button"
          className="tt-time-link"
          onClick={() => seek(c.at)}
          aria-label={`Play from ${formatClock(c.at)}`}
        >
          {formatClock(c.at)}
        </button>
        <span className="tt-muted">{anchorLabel(c)}</span>
      </div>
      <p className="tt-thread-text">{c.text}</p>
      {replies.length ? (
        <ul className="tt-replies" aria-label="Replies">
          {replies.map((r) => (
            <li key={r.id} className="tt-reply" data-speaker={r.by.speaker || undefined}>
              <strong>{r.by.name}</strong>
              {r.by.speaker ? <span className="tt-tag">Speaker</span> : null} <span>{r.text}</span>
              {me && mayChange(me, r.by) && canWrite ? (
                <button type="button" className="tt-link-button" onClick={() => void send({ kind: "hide", id: r.id })}>
                  Hide
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {later ? <p className="tt-muted">{later === 1 ? "1 later reply" : `${later} later replies`}</p> : null}
      <div className="tt-row tt-thread-actions">
        {canWrite ? (
          <button
            type="button"
            className="tt-link-button"
            onClick={() => setReplying(!replying)}
            aria-expanded={replying}
          >
            Reply
          </button>
        ) : null}
        {me && mayChange(me, c.by) && canWrite ? (
          <button type="button" className="tt-link-button" onClick={() => void send({ kind: "hide", id: c.id })}>
            Hide
          </button>
        ) : null}
      </div>
      {replying ? (
        <form
          className="tt-reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void send({ kind: "reply", to: c.id, text: text.trim() }).then((ok) => {
              if (ok) {
                setText("");
                setReplying(false);
              }
            });
          }}
        >
          <input
            className="tt-input"
            aria-label={`Reply to ${c.by.name}`}
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button type="submit" className="tt-button tt-small" disabled={!text.trim()}>
            Send
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="tt-discussion-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

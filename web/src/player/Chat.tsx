import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type RoomService, WriteError } from "../annotate/client";
import { CHAT_MAX } from "../contracts/types";
import { MoqHistorySource } from "../playback/moqSource";
import type { HistorySource } from "../playback/source";
import { MoqTransport } from "../transport/moq";
import { ChatFeed, randomName } from "./chatFeed";
import "./chat.css";
import { usePlayer } from "./context";

const noop = () => () => {};
const zero = () => 0;

export interface ChatProps {
  /** Where the chat track is read from; undefined without a relay (the offline demo). */
  source: HistorySource | undefined;
  room: string;
  /** The room service's session, for writing; undefined where nobody can write. */
  service?: RoomService;
  /** The playhead is behind live: show the chat as it was then. */
  rewound: boolean;
  /** The playhead, room ms. */
  at: number | undefined;
  talkClock: (ms: number) => string;
  /** Show the conversation only (the speaker console's audience area). */
  readOnly?: boolean;
}

/** The chat drawer of the side panel, wired to the player. */
export function ChatTab() {
  const { transport, roomName, listening, view, at, talkClock } = usePlayer();
  const source = useMemo(
    () => (transport instanceof MoqTransport ? new MoqHistorySource(transport) : undefined),
    [transport],
  );
  return (
    <Chat
      source={source}
      room={roomName}
      service={listening?.service}
      rewound={view.timeline.mode === "rewound"}
      at={at}
      talkClock={talkClock}
    />
  );
}

/**
 * The room's chat (ticket 0021). Mounted, it subscribes to talk/<room>/chat; unmounted, it unsubscribes (decision
 * 0026: a panel is a subscription). It says when it is loading what came before and when it starts from now. Live,
 * it shows the last 50 messages and every new one; rewound, the chat as it was at the playhead. A listener without a
 * name gets a random one, which "Change name" replaces.
 */
export function Chat({ source, room, service, rewound, at, talkClock, readOnly }: ChatProps) {
  const feed = useMemo(() => (source ? new ChatFeed(source, room) : undefined), [source, room]);
  useEffect(() => {
    if (!feed) return;
    feed.start();
    return () => feed.stop();
  }, [feed]);
  useEffect(() => feed?.setTime(at, rewound), [feed, at, rewound]);
  useSyncExternalStore(feed?.subscribe ?? noop, feed?.getVersion ?? zero);
  useSyncExternalStore(service?.subscribe ?? noop, service?.version ?? zero);

  const body = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const shown = feed?.view();
  const messages = shown?.messages ?? [];
  const last = messages.at(-1);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [following, last?.data.id, messages.length]);

  if (!feed || !shown) return <p className="tt-empty">Chat needs a connection to the relay.</p>;

  const status =
    shown.phase === "loading"
      ? rewound
        ? "Loading the chat at this point…"
        : "Loading the chat so far…"
      : messages.length === 0
        ? rewound
          ? "Nothing said up to here."
          : "Starting from now: messages show here as people write."
        : undefined;

  return (
    <div className="tt-chat">
      {status ? (
        <p className="tt-muted tt-track-status" role="status">
          {status}
        </p>
      ) : null}
      <ol
        ref={body}
        className="tt-chat-list"
        aria-label="Chat messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {messages.map((r) => (
          <li key={r.data.id} className="tt-chat-message" data-speaker={r.data.by.speaker ? "" : undefined}>
            <span className="tt-chat-head">
              <strong>{r.data.by.name}</strong>
              {r.data.by.speaker ? <span className="tt-chat-tag">speaker</span> : null}
              <span className="tt-muted">{talkClock(r.m)}</span>
            </span>
            <span className="tt-chat-text">{r.data.text}</span>
          </li>
        ))}
      </ol>
      {!following ? (
        <button type="button" className="tt-jump" onClick={() => setFollowing(true)}>
          Jump to latest
        </button>
      ) : null}
      {service && !readOnly ? <Composer service={service} rewound={rewound} /> : null}
    </div>
  );
}

function Composer({ service, rewound }: { service: RoomService; rewound: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const status = service.status();
  const me = service.me();

  // No account: a listener without a name gets a random one, shown with what they write (brand.md §6).
  useEffect(() => {
    if (status === "open" && me && !me.name && !me.speaker) service.setName(randomName());
  }, [service, status, me]);

  if (status !== "open") {
    return (
      <p className="tt-muted tt-chat-closed" role="status">
        Sending waits for the room service; the chat itself keeps playing.
      </p>
    );
  }

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await service.write("chat", { text: message });
      setText("");
    } catch (err) {
      setError(
        err instanceof WriteError && err.code === "not-live"
          ? "Chat opens when the talk starts."
          : err instanceof WriteError && err.code === "rate"
            ? "Slow down a little: one message every 2 s."
            : err instanceof Error
              ? err.message
              : "Not sent",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tt-chat-composer">
      {naming ? (
        <NameForm
          current={me?.name ?? ""}
          onDone={(name) => {
            if (name) service.setName(name);
            setNaming(false);
          }}
        />
      ) : (
        <div className="tt-row tt-chat-me">
          <span className="tt-muted">
            You are <strong>{me?.name ?? "…"}</strong>
          </span>
          {me && !me.speaker ? (
            <button type="button" className="tt-button tt-secondary tt-small" onClick={() => setNaming(true)}>
              Change name
            </button>
          ) : null}
        </div>
      )}
      <form className="tt-row tt-chat-send" onSubmit={(e) => void send(e)}>
        <textarea
          className="tt-input"
          rows={1}
          maxLength={CHAT_MAX}
          aria-label="Chat message"
          placeholder={rewound ? "Say something (sent live)" : "Say something"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="tt-button" disabled={!text.trim() || busy}>
          Send
        </button>
      </form>
      {error ? (
        <p className="tt-discussion-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The optional name dialog: the display name shown with what this listener writes, kept in this browser. */
function NameForm({ current, onDone }: { current: string; onDone: (name: string | undefined) => void }) {
  const [name, setName] = useState(current);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.select(), []);
  return (
    <form
      className="tt-chat-name"
      aria-label="Your name"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(name.trim() || undefined);
      }}
    >
      <label className="tt-menu-heading" htmlFor="tt-chat-name">
        Your name, shown with what you write
      </label>
      <div className="tt-row">
        <input
          ref={box}
          id="tt-chat-name"
          className="tt-input"
          value={name}
          maxLength={60}
          autoComplete="nickname"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onDone(undefined);
          }}
        />
        <button type="submit" className="tt-button tt-small" disabled={!name.trim()}>
          Save
        </button>
        <button type="button" className="tt-button tt-secondary tt-small" onClick={() => onDone(undefined)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

import "./hub.css";
import { type FormEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { LogoMark } from "../brand/LogoMark";
import { RELAY_URL } from "../config";
import { normaliseRoom } from "../contracts/names";
import { Link, navigate } from "../router";
import { type CreateTalkProps, StartTalkDialog } from "./CreateTalk";
import { speakerPathFrom } from "./createRoom";
import { DEMO_CREDIT, DEMO_ROOMS } from "./demoRooms";
import { Hero } from "./hub/Hero";
import { PlusIcon, SearchIcon } from "./hub/icons";
import { hubRows } from "./hub/items";
import { Row } from "./hub/Row";
import { Tile } from "./hub/Tile";
import { type AnnounceSource, type RelayRooms, watchRelayRooms } from "./liveRooms";
import { fetchRecordings, type Recording } from "./recordings";
import { readRecent } from "./recentRooms";

/** A no-break space: a speaker's name never breaks across lines. */
const NBSP = " ";

export interface LandingPageProps {
  /** The relay connection for what is on air; by default the hub's own narrow watch (teacherAnnouncements.ts). */
  transport?: AnnounceSource | null;
  create?: CreateTalkProps["create"];
  /** The archive's room list, for the Recordings row; by default GET /archive/rooms.json. */
  recordings?: () => Promise<Recording[]>;
}

/** The room a person typed or pasted: a room name, or a /watch/<room> link. */
export function roomFrom(input: string): string | null {
  const text = input.trim();
  const watch = /\/watch\/([^/?#]+)/.exec(text);
  return normaliseRoom(watch ? decodeURIComponent(watch[1]!) : text);
}

/**
 * The hub (J2, J5, J8; decisions 0033, 0036): a streaming front page. The hero features one demo lecture's live
 * session; rows of cards hold the other live sessions and talks on air, what this browser watched lately and the
 * recordings, so each talk shows once live and once recorded. Everything a first paint needs comes from static data
 * (the demo lectures and their recordings), so nothing moves when the relay and the archive answer. Join takes a room
 * name, an audience link or a speaker link; Start a talk opens its modal.
 */
export function LandingPage({ transport, create, recordings: loadRecordings = fetchRecordings }: LandingPageProps) {
  const relay = useRelayRooms(transport);
  const recordings = useRecordings(loadRecordings);
  const [recent] = useState(() => readRecent());
  // `/?start` (the console's "Start another talk") opens Start a talk at once.
  const [starting, setStarting] = useState(() => new URLSearchParams(location.search).has("start"));
  const rows = useMemo(() => hubRows({ relay, recordings, recent }), [relay, recordings, recent]);
  const relayDown = relay?.status === "failed" || relay?.status === "disconnected";
  const note = relayDown ? "Live status is unavailable right now." : undefined;

  return (
    <div className="hub">
      <header className="hub-bar">
        <Link href="/" className="hub-brand" aria-label="Talk Tracks, home">
          <LogoMark size={22} />
          <span>Talk Tracks</span>
        </Link>
        <nav className="hub-nav" aria-label="Sections">
          <a href="#live">Live</a>
          <a href="#recordings">Recordings</a>
        </nav>
        <JoinRoom />
        <button type="button" className="hub-btn hub-btn-quiet hub-start" onClick={() => setStarting(true)}>
          <PlusIcon />
          Start a talk
        </button>
      </header>

      <main className="hub-main" id="main">
        <h1 className="sr-only">Talk Tracks</h1>
        <Hero item={rows.featured} />

        <div className="hub-rows">
          <Row
            id="live"
            title="Live now"
            note={note ?? "Recorded talks replayed live, with live subtitles and tracks."}
          >
            {rows.live.map((item) => (
              <Tile key={item.room} item={item} live={false} />
            ))}
          </Row>

          {rows.recent.length ? (
            <Row id="recent" title="Continue watching" note="Kept in this browser only.">
              {rows.recent.map((item) => (
                <Tile key={item.room} item={item} />
              ))}
            </Row>
          ) : null}

          {rows.recordings.length ? (
            <Row id="recordings" title="Recordings" note="The whole lecture, from the start.">
              {rows.recordings.map((item) => (
                <Tile key={item.room} item={item} />
              ))}
            </Row>
          ) : null}
        </div>
      </main>

      <footer className="hub-foot">
        <p>
          Live talks with AI tracks you pick: captions, translations, slide descriptions and chapters. Can&rsquo;t
          connect? <Link href="/demo">Watch the offline demo</Link>.
        </p>
        <p className="hub-credits">
          Demo lectures, and the stills from their recordings: {DEMO_CREDIT},{" "}
          {DEMO_ROOMS.map((d, i) => (
            <span key={d.room}>
              {i ? ", " : null}
              <a href={d.source} rel="noreferrer" target="_blank">
                {d.speaker.replaceAll(" ", NBSP)}
              </a>
            </span>
          ))}
          .
        </p>
      </footer>

      <StartTalkDialog open={starting} onClose={() => setStarting(false)} create={create} />
    </div>
  );
}

/** Join: a room name, an audience link or a speaker link, from one box. Ctrl K (⌘K) jumps here. */
function JoinRoom() {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useJoinShortcut(input);
  const join = (e?: FormEvent) => {
    e?.preventDefault();
    const speaker = speakerPathFrom(text);
    if (speaker) return navigate(speaker);
    const name = roomFrom(text);
    if (!name) {
      setError("Room names are 3 to 40 letters, digits or dashes.");
      return;
    }
    navigate(`/watch/${encodeURIComponent(name)}`);
  };
  return (
    <form className="hub-join" onSubmit={join} aria-label="Join a room" role="search">
      <div className="hub-join-field" onClick={() => input.current?.focus()}>
        <SearchIcon />
        <label className="sr-only" htmlFor="hub-join-input">
          Room name or link
        </label>
        <input
          ref={input}
          id="hub-join-input"
          name="room"
          value={text}
          placeholder="Join a room: name or link"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "join-error" : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(undefined);
          }}
        />
        <kbd className="hub-join-kbd" aria-hidden="true">
          Ctrl K
        </kbd>
      </div>
      <button type="submit" className="hub-join-go">
        Join
      </button>
      {error ? (
        <p className="hub-join-error" id="join-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function useJoinShortcut(input: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k" || !input.current) return;
      e.preventDefault();
      input.current.focus();
      input.current.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [input]);
}

/** The archive's recordings; undefined while loading. */
function useRecordings(load: () => Promise<Recording[]>): Recording[] | undefined {
  const [list, setList] = useState<Recording[]>();
  useEffect(() => {
    let live = true;
    load().then(
      (r) => live && setList(r),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return list;
}

/** The relay's rooms on air; undefined until there is a connection to ask. */
function useRelayRooms(given: AnnounceSource | null | undefined): RelayRooms | undefined {
  const own = useOwnWatch(given === undefined);
  const source = given ?? own;
  const [rooms, setRooms] = useState<RelayRooms>();
  useEffect(() => {
    if (!source) return;
    const w = watchRelayRooms(source, setRooms);
    return () => w.close();
  }, [source]);
  return source ? rooms : undefined;
}

/**
 * The hub's own relay watch, one for the page's lifetime. It is a chunk of its own (it pulls in @moq/net), loaded
 * once the browser is idle after the hub's first paint, so neither the entry script nor the first frames wait for it.
 */
function useOwnWatch(wanted: boolean): AnnounceSource | undefined {
  const [source, setSource] = useState<AnnounceSource>();
  useEffect(() => {
    if (!wanted) return;
    let closed = false;
    let made: { close(): void } | undefined;
    const start = () =>
      void import("./teacherAnnouncements").then(({ TeacherAnnouncements }) => {
        if (closed) return;
        // Watching needs no token.
        const watch = new TeacherAnnouncements(new URL(RELAY_URL));
        made = watch;
        setSource(watch);
      });
    const idle = window.requestIdleCallback?.(start, { timeout: 1500 });
    const timer = idle === undefined ? window.setTimeout(start, 200) : undefined;
    return () => {
      closed = true;
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      window.clearTimeout(timer);
      made?.close();
      setSource(undefined);
    };
  }, [wanted]);
  return source;
}

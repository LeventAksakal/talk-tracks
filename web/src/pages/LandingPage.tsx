import { Button, TextInput } from "@astryxdesign/core";
import { type FormEvent, useEffect, useState } from "react";
import { RELAY_URL } from "../config";
import { normaliseRoom } from "../contracts/names";
import { Icon } from "../player/icons";
import { Link, navigate } from "../router";
import { MoqTransport, relayUrl } from "../transport/moq";
import type { Transport } from "../transport/types";
import { useResource } from "../useResource";
import { CreateTalk, type CreateTalkProps, PasteSpeakerLink } from "./CreateTalk";
import { DEMO_CREDIT, DEMO_ROOMS, demoRoom } from "./demoRooms";
import { type RelayRooms, watchRelayRooms } from "./liveRooms";
import { readRecent, type RecentRoom } from "./recentRooms";

export interface LandingPageProps {
  /** The relay connection for what is on air; by default one MoqTransport for the page's lifetime. */
  transport?: Transport | null;
  create?: CreateTalkProps["create"];
}

/** The room a person typed or pasted: a room name, or a /watch/<room> link. */
export function roomFrom(input: string): string | null {
  const text = input.trim();
  const watch = /\/watch\/([^/?#]+)/.exec(text);
  return normaliseRoom(watch ? decodeURIComponent(watch[1]!) : text);
}

/**
 * The hub (J2, J5, J8; ui-design §8; the canvas's Hub board): join a room by name or link, the rooms on air now,
 * the rooms this browser watched lately, the demo lectures, and Create talk with an access code (decision 0025).
 */
export function LandingPage({ transport, create }: LandingPageProps) {
  const relay = useRelayRooms(transport);
  const connected = relay?.status === "connected";
  const [recent] = useState(() => readRecent());
  const onAir = connected ? [...relay.live].filter((r) => !demoRoom(r)).sort() : [];
  useJoinShortcut();

  return (
    <div className="hub">
      <header className="hub-bar">
        <span className="hub-brand">Talk Tracks</span>
        <a className="hub-create" href="#give-heading">
          Create talk
        </a>
      </header>
      <main className="hub-main" id="main">
        <section className="hub-hero" aria-labelledby="hub-title">
          <h1 className="hub-title" id="hub-title">
            Talk Tracks
          </h1>
          <p className="lead">
            A player for live talks. While the speaker talks, AI agents each publish their own live track into the same
            broadcast: subtitles, a translation per language, a description of every new slide, chapters and a glossary.
            Pick what you want, and rewind to any moment.
          </p>
          <JoinRoom />
        </section>

        <section className="lobby-section" aria-labelledby="live-heading">
          <h2 id="live-heading">Live now</h2>
          {connected ? (
            onAir.length ? (
              <ul className="lobby-cards">
                {onAir.map((room) => (
                  <li key={room} className="lobby-card hub-live-card">
                    <LiveBadge />
                    <Link href={`/watch/${room}`} className="lobby-card-link">
                      <span className="lobby-card-title">{room}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" role="status">
                Nothing is on air right now. Try a demo lecture below, or give a talk.
              </p>
            )
          ) : (
            <p className="muted" role="status">
              {relay?.status === "failed" || relay?.status === "disconnected"
                ? "The relay can't be reached right now, so live rooms can't be listed. Links and the offline demo still open."
                : "Checking what is on air…"}
            </p>
          )}
        </section>

        {recent.length ? (
          <section className="lobby-section" aria-labelledby="recent-heading">
            <h2 id="recent-heading">Continue watching</h2>
            <p className="muted small">Kept in this browser only.</p>
            <ul className="hub-recent">
              {recent.map((r) => (
                <RecentCard key={r.room} recent={r} live={connected ? relay.live.has(r.room) : undefined} />
              ))}
            </ul>
          </section>
        ) : null}

        <section className="lobby-section" aria-labelledby="demos-heading">
          <h2 id="demos-heading">Demo lectures</h2>
          <p className="muted">
            Four recorded talks looped as if live, with their AI tracks generated once. Open one to try subtitles,
            translation, chapters and rewind.
          </p>
          <ul className="lobby-cards">
            {DEMO_ROOMS.map((d) => (
              <li key={d.room} className="lobby-card">
                {connected ? (
                  <span className="lobby-card-state" data-live={relay.live.has(d.room) ? "true" : "false"}>
                    {relay.live.has(d.room) ? (
                      <>
                        <LiveBadge /> <span className="muted small">looped recording</span>
                      </>
                    ) : (
                      <span className="hub-off-air">Off air</span>
                    )}
                  </span>
                ) : null}
                <Link href={`/watch/${d.room}`} className="lobby-card-link">
                  <span className="lobby-card-title">{d.title}</span>
                </Link>
                <span className="lobby-card-speaker">{d.speaker}</span>
                <span className="muted small">
                  <a href={d.source} rel="noreferrer" target="_blank">
                    {DEMO_CREDIT}
                  </a>
                </span>
              </li>
            ))}
          </ul>
          <p className="small">
            <Link href="/demo">Offline demo</Link>: a scripted talk that runs in this tab, with no relay.
          </p>
        </section>

        <section className="lobby-section hub-give" aria-labelledby="give-heading">
          <h2 id="give-heading">Give a talk</h2>
          <p className="muted">
            Create a room with the access code you were given. You get a private speaker link for the console and an
            audience link with a QR code to project.
          </p>
          <CreateTalk create={create} />
          <h3 className="lobby-subheading">Already have a speaker link?</h3>
          <PasteSpeakerLink />
        </section>

        <section className="lobby-section landing-how" aria-labelledby="how-heading">
          <h2 id="how-heading">How it works</h2>
          <p>
            Everything travels over Media over QUIC. Each AI step is a separate publisher, so agents can be added,
            swapped or restarted mid-talk, and a relay&apos;s cache serves anyone who joins late. Built with Meta&apos;s
            Muse models and the Astryx design system.
          </p>
        </section>
      </main>
    </div>
  );
}

/** The LIVE marker on a card (brand §6): the Go-live icon and the word on the live fill. */
function LiveBadge() {
  return (
    <span className="hub-live-badge">
      <Icon name="live" />
      LIVE
    </span>
  );
}

function RecentCard({ recent, live }: { recent: RecentRoom; live: boolean | undefined }) {
  const demo = demoRoom(recent.room);
  return (
    <li className="hub-recent-item">
      <Link href={`/watch/${recent.room}`}>{demo?.title ?? recent.title ?? recent.room}</Link>
      {live ? <LiveBadge /> : null}
    </li>
  );
}

function JoinRoom() {
  const [room, setRoom] = useState("");
  const [error, setError] = useState<string>();
  const join = (e?: FormEvent) => {
    e?.preventDefault();
    const name = roomFrom(room);
    if (!name) {
      setError("Room names are 3 to 40 letters, digits or dashes.");
      return;
    }
    navigate(`/watch/${encodeURIComponent(name)}`);
  };
  return (
    <form className="join-form" onSubmit={join} aria-label="Join a room">
      <TextInput
        label="Room name or link"
        description="The name the speaker gave you, for example physics-101, or the audience link. Ctrl K jumps here."
        value={room}
        onChange={(v) => {
          setRoom(v);
          setError(undefined);
        }}
        onEnter={() => join()}
        status={error ? { type: "error", message: error } : undefined}
        htmlName="room"
      />
      <Button label="Join" type="submit" variant="primary" />
    </form>
  );
}

/** Ctrl K (⌘K) focuses the join box from anywhere on the hub. */
function useJoinShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      const input = document.querySelector<HTMLInputElement>('input[name="room"]');
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** The relay's rooms on air; undefined until there is a connection to ask. */
function useRelayRooms(given: Transport | null | undefined): RelayRooms | undefined {
  const own = useResource(
    () => (given === undefined ? new MoqTransport({ url: relayUrl(RELAY_URL) }) : undefined),
    [given],
  );
  const transport = given ?? own;
  const [rooms, setRooms] = useState<RelayRooms>();
  useEffect(() => {
    if (!transport) return;
    const w = watchRelayRooms(transport, setRooms);
    return () => w.close();
  }, [transport]);
  return transport ? rooms : undefined;
}

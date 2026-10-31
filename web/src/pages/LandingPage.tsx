import { Badge, Button, TextInput } from "@astryxdesign/core";
import { type FormEvent, useEffect, useState } from "react";
import { RELAY_URL } from "../config";
import { normaliseRoom } from "../contracts/names";
import { Link, navigate } from "../router";
import { MoqTransport, relayUrl } from "../transport/moq";
import type { Transport } from "../transport/types";
import { useResource } from "../useResource";
import { CreateTalk, type CreateTalkProps, PasteSpeakerLink } from "./CreateTalk";
import { DEMO_CREDIT, DEMO_ROOMS } from "./demoRooms";
import { type LiveRooms, watchLiveRooms } from "./liveRooms";

export interface LandingPageProps {
  /** The relay connection for the live badges; by default one MoqTransport for the page's lifetime. */
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
 * The lobby (J2, J5, J8; ui-design §8): what this is, the demo lectures with their live state, join a room by name
 * or link, create a talk with an access code, or open a speaker link.
 */
export function LandingPage({ transport, create }: LandingPageProps) {
  const live = useLiveRooms(transport);
  return (
    <main className="landing" id="main">
      <h1 className="landing-title">Talk Tracks</h1>
      <p className="lead">
        A player for live talks. While the speaker talks, AI agents each publish their own live track into the same
        broadcast: captions, a translation per language, a description of every new slide, and chapters, a glossary and
        a recap for anyone who arrives late. You turn on the tracks you want, and you can rewind to any moment.
      </p>

      <section className="lobby-section" aria-labelledby="demos-heading">
        <h2 id="demos-heading">Demo lectures</h2>
        <p className="muted">
          Four recorded talks looped as if live, with AI tracks generated once. Open one to try subtitles, translation,
          chapters and rewind.
        </p>
        <ul className="lobby-cards">
          {DEMO_ROOMS.map((d) => (
            <li key={d.room} className="lobby-card">
              <Link href={`/watch/${d.room}`} className="lobby-card-link">
                <span className="lobby-card-title">{d.title}</span>
              </Link>
              <span className="lobby-card-speaker">{d.speaker}</span>
              <span className="muted small">
                <a href={d.source} rel="noreferrer" target="_blank">
                  {DEMO_CREDIT}
                </a>
              </span>
              {live === undefined ? null : (
                <span className="lobby-card-state" data-live={live.get(d.room) ? "true" : "false"}>
                  <Badge
                    label={live.get(d.room) ? "Live" : "Not live"}
                    variant={live.get(d.room) ? "error" : "neutral"}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="small">
          <Link href="/demo">Offline demo</Link>: a scripted talk that runs in this tab, with no relay.
        </p>
      </section>

      <section className="lobby-section" aria-labelledby="join-heading">
        <h2 id="join-heading">Join a room</h2>
        <JoinRoom />
      </section>

      <section className="lobby-section" aria-labelledby="create-heading">
        <h2 id="create-heading">Give a talk</h2>
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
          Everything travels over Media over QUIC. Each AI step is a separate publisher, so agents can be added, swapped
          or restarted mid-talk, and a relay's cache serves anyone who joins late. Built with Meta's Muse models and the
          Astryx design system.
        </p>
      </section>
    </main>
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
        description="The name the speaker gave you, for example physics-101, or the audience link."
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

/** The demo rooms' live state from relay announcements; undefined (no badges) until the relay answers. */
function useLiveRooms(given: Transport | null | undefined): LiveRooms {
  const own = useResource(
    () => (given === undefined ? new MoqTransport({ url: relayUrl(RELAY_URL) }) : undefined),
    [given],
  );
  const transport = given ?? own;
  const [live, setLive] = useState<LiveRooms>();
  useEffect(() => {
    if (!transport) return;
    const w = watchLiveRooms(
      transport,
      DEMO_ROOMS.map((d) => d.room),
      setLive,
    );
    return () => w.close();
  }, [transport]);
  return transport ? live : undefined;
}

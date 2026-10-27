import { Button, TextInput } from "@astryxdesign/core";
import { type FormEvent, useState } from "react";
import { normaliseRoom } from "../contracts/names";
import { Link, navigate } from "../router";

export function LandingPage() {
  const [room, setRoom] = useState("");
  const [error, setError] = useState<string>();

  const join = (e?: FormEvent) => {
    e?.preventDefault();
    const name = normaliseRoom(room);
    if (!name) {
      setError("Room names are 3 to 32 letters, digits or dashes.");
      return;
    }
    navigate(`/watch/${encodeURIComponent(name)}`);
  };

  return (
    <main className="landing" id="main">
      <h1 className="landing-title">Talk Tracks</h1>
      <p className="lead">
        A speaker talks. AI agents each publish their own live track into the same broadcast: captions, a translation
        per language, a description of every new slide for listeners who cannot see it, and chapters, a glossary and a
        recap for anyone who arrives late. You pick the tracks you want.
      </p>
      <form className="join-form" onSubmit={join} aria-label="Join a room">
        <TextInput
          label="Room name"
          description="The name the speaker gave you, for example physics-101."
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
      <ul className="landing-links">
        <li>
          <Link href="/demo">Try the offline demo</Link>: a scripted talk, no relay needed.
        </li>
        <li>
          Speaking? Open <code>/talk/&lt;room&gt;?token=…</code> with the publishing token you were given.
        </li>
      </ul>
      <section className="landing-how" aria-labelledby="how-heading">
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

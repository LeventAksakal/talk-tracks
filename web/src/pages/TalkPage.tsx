import { Badge, Banner, Button } from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";
import { AUDIO_TRACK, FRAMES_TRACK, isValidRoom, slidesPath, teacherPath } from "../contracts/names";
import { HANG_CATALOG_TRACK, hangClockOfPayload } from "../playback/roomClock";
import { useRoomStatus } from "../playback/roomStatus";
import { Link, useLocation } from "../router";
import { type MicHandle, startMic } from "../speaker/mic";
import { FRESH_AUDIO_MS, isOwnAudio, type MicState, type OnAir, onAirState } from "../speaker/onair";
import { type SharedSlide, SlideSharer } from "../speaker/slides";
import { useMoqTransport } from "../transport/useTransport";
import { HealthDot } from "../viewer/panels";
import { NotFound } from "./NotFound";

export function TalkPage({ room }: { room: string }) {
  const { search } = useLocation();
  const token = new URLSearchParams(search).get("token") ?? undefined;
  if (!isValidRoom(room)) return <NotFound what={`"${room}" is not a room name.`} />;
  return <Console room={room} token={token} />;
}

function Console({ room, token }: { room: string; token: string | undefined }) {
  // Two connections: the publisher carries the token; the watcher is anonymous, like any viewer, so
  // what it sees is what the relay really accepted.
  const publisher = useMoqTransport(token);
  const watcher = useMoqTransport();
  const view = useRoomStatus(watcher, room);

  const [publisherStatus, setPublisherStatus] = useState(publisher?.status() ?? "connecting");
  const [publisherError, setPublisherError] = useState<string>();
  useEffect(() => {
    if (!publisher) return;
    const sub = publisher.onStatus((status, error) => {
      setPublisherStatus(status);
      setPublisherError(error?.message);
    });
    return () => sub.close();
  }, [publisher]);

  // --- microphone ---
  const [mic, setMic] = useState<MicState>("off");
  const [micError, setMicError] = useState<string>();
  const micHandle = useRef<MicHandle | undefined>(undefined);
  const [startedAt, setStartedAt] = useState(0);
  const [clock, setClock] = useState<{ now: number; ownAt?: number; otherAt?: number }>({ now: 0 });
  const teacherLive = view?.teacherLive ?? false;
  // Arrival times (Date.now) of the newest audio frame the anonymous watcher got back from the
  // relay: our own, and anyone else's on the same path. Refs, so 50 frames a second don't re-render;
  // the one-second tick below reads them.
  const ownAudioAt = useRef<number | undefined>(undefined);
  const otherAudioAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!watcher || mic === "off" || mic === "error") return;
    ownAudioAt.current = undefined;
    otherAudioAt.current = undefined;
    const sub = watcher.subscribe(
      teacherPath(room),
      AUDIO_TRACK,
      ({ payload, receivedAt }) => {
        if (isOwnAudio(payload, performance.now())) ownAudioAt.current = receivedAt;
        else otherAudioAt.current = receivedAt;
      },
      { maxAgeMs: 0 },
    );
    return () => sub.close();
  }, [watcher, room, mic]);

  useEffect(() => {
    if (mic === "off") return;
    const t = setInterval(
      () => setClock({ now: Date.now(), ownAt: ownAudioAt.current, otherAt: otherAudioAt.current }),
      1_000,
    );
    return () => clearInterval(t);
  }, [mic]);

  useEffect(() => () => micHandle.current?.close(), []);

  // Room time comes from the root `clock` of the speaker's hang catalog (design §4.5): without it
  // nothing the room records lines up, so say so while on air.
  const [hasClock, setHasClock] = useState<boolean>();
  useEffect(() => {
    if (!watcher || mic === "off" || mic === "error") return;
    const sub = watcher.subscribe(teacherPath(room), HANG_CATALOG_TRACK, ({ payload }) =>
      setHasClock(hangClockOfPayload(payload) !== undefined),
    );
    return () => {
      sub.close();
      setHasClock(undefined);
    };
  }, [watcher, room, mic]);

  const startMicrophone = async () => {
    if (!publisher) return;
    setMic("starting");
    setMicError(undefined);
    setStartedAt(Date.now());
    setClock({ now: Date.now() });
    try {
      micHandle.current = await startMic(publisher, room, (e) => {
        setMic("error");
        setMicError(e.message);
      });
      setMic((m) => (m === "starting" ? "publishing" : m));
    } catch (e) {
      setMic("error");
      setMicError(String(e));
    }
  };

  const stopMicrophone = () => {
    micHandle.current?.close();
    micHandle.current = undefined;
    setMic("off");
  };

  const onAir = onAirState({
    mic,
    micError,
    publisherStatus,
    publisherError,
    ownAudioAgoMs: clock.ownAt === undefined ? undefined : clock.now - clock.ownAt,
    otherSpeaker: clock.otherAt !== undefined && clock.now - clock.otherAt < FRESH_AUDIO_MS,
    elapsedMs: clock.now - startedAt,
  });

  return (
    <div className="console">
      <header className="room-header">
        <div className="room-title">
          <Link href="/" className="brand">
            Talk Tracks
          </Link>
          <h1>Speaker console: {room}</h1>
        </div>
        <OnAirBadge onAir={onAir} />
      </header>
      {!token ? (
        <Banner
          status="info"
          title="No publishing token"
          description="Rooms on a public relay need a token in the address (?token=…). A local development relay works without one."
        />
      ) : null}
      <div className="console-grid">
        <section className="panel" aria-labelledby="mic-heading">
          <h2 id="mic-heading" className="panel-title">
            Microphone
          </h2>
          <OnAirMessage onAir={onAir} />
          {hasClock === false ? (
            <Banner
              status="error"
              title="No room clock"
              description="Your broadcast carries no clock, so captions and the recording will not line up. Reload the page and go on air again."
              role="alert"
            />
          ) : null}
          {mic === "off" || mic === "error" ? (
            <Button label="Go on air" variant="primary" isDisabled={!publisher} clickAction={startMicrophone} />
          ) : (
            <Button label="Stop" variant="destructive" onClick={stopMicrophone} />
          )}
          <p className="muted small" data-testid="relay-view">
            As viewers see the relay: {teacherLive ? "a speaker broadcast is on air" : "no speaker broadcast"}
            {view?.slidesLive ? ", slides shared" : ""}.
          </p>
          <p className="muted">
            Viewers can watch at{" "}
            <Link href={`/watch/${room}`}>
              {location.origin}/watch/{room}
            </Link>
          </p>
        </section>
        <SlideShare publisher={publisher} room={room} />
        <Roster agents={view?.agents ?? []} />
      </div>
    </div>
  );
}

function OnAirBadge({ onAir }: { onAir: OnAir }) {
  const [variant, label] =
    onAir.kind === "on-air"
      ? (["error", "● On air"] as const)
      : onAir.kind === "confirming" || onAir.kind === "starting"
        ? (["warning", "Connecting…"] as const)
        : onAir.kind === "off"
          ? (["neutral", "Off air"] as const)
          : (["error", "Not on air"] as const);
  return (
    <span role="status">
      <Badge variant={variant} label={label} />
    </span>
  );
}

function OnAirMessage({ onAir }: { onAir: OnAir }) {
  switch (onAir.kind) {
    case "off":
      return <p>Your microphone is off. Going on air asks for microphone access.</p>;
    case "starting":
      return <p>Starting the microphone…</p>;
    case "confirming":
      return (
        <p>
          Publishing; waiting for the relay to confirm.
          {onAir.occupied ? " Another broadcast is already on air in this room." : ""}
        </p>
      );
    case "on-air":
      return <p>On air: the relay is carrying your microphone.</p>;
    case "refused":
    case "error":
      return <Banner status="error" title="Not on air" description={onAir.reason} role="alert" />;
  }
}

function SlideShare({ publisher, room }: { publisher: ReturnType<typeof useMoqTransport>; room: string }) {
  const [sharer, setSharer] = useState<SlideSharer>();
  const [last, setLast] = useState<SharedSlide>();
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string>();
  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

  useEffect(() => () => sharer?.stop(), [sharer]);
  useEffect(() => () => (last ? URL.revokeObjectURL(last.url) : undefined), [last]);

  const start = async () => {
    if (!publisher) return;
    setError(undefined);
    try {
      // Must run inside the click: screen capture needs the user gesture.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const s = new SlideSharer(stream, publisher.publish(slidesPath(room), FRAMES_TRACK));
      s.onSlide = (slide) => {
        setLast(slide);
        setCount((c) => c + 1);
      };
      s.onEnded = () => setSharer(undefined);
      await s.start();
      setSharer(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="panel" aria-labelledby="slides-share-heading">
      <h2 id="slides-share-heading" className="panel-title">
        Slides
      </h2>
      <p>
        Share the window with your slides. A new picture goes out only when the slide changes (at most one every two
        seconds), and an agent describes it for listeners who cannot see it.
      </p>
      {!supported ? <p>This browser cannot share its screen.</p> : null}
      {sharer ? (
        <Button
          label="Stop sharing"
          variant="secondary"
          onClick={() => {
            sharer.stop();
            setSharer(undefined);
          }}
        />
      ) : (
        <Button label="Share slides" isDisabled={!supported || !publisher} onClick={() => void start()} />
      )}
      {error ? <p role="alert">Could not share the screen: {error}</p> : null}
      {last ? (
        <figure className="slide-preview">
          <img src={last.url} alt={`Slide ${last.id + 1} as sent`} />
          <figcaption className="muted">
            {count} slide{count === 1 ? "" : "s"} sent; last one {Math.round(last.bytes / 1024)} KB
          </figcaption>
        </figure>
      ) : null}
    </section>
  );
}

/** The agents announced in the room. Announcements only: the console subscribes to no agent, so it costs nothing. */
function Roster({ agents }: { agents: readonly string[] }) {
  return (
    <section className="panel roster" aria-labelledby="roster-heading">
      <h2 id="roster-heading" className="panel-title">
        Agents
      </h2>
      {agents.length === 0 ? (
        <p className="muted">No agent has joined this room yet.</p>
      ) : (
        <table className="roster-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Health</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((name) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>
                  <HealthDot health="live" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

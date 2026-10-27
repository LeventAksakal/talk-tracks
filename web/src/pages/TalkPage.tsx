import { Badge, Banner, Button } from "@astryxdesign/core";
import { useEffect, useRef, useState } from "react";
import { FRAMES_TRACK, isValidRoom, slidesPath } from "../contracts/names";
import type { AgentView } from "../room/store";
import { useRoom } from "../room/useRoom";
import { Link, useLocation } from "../router";
import { type MicHandle, startMic } from "../speaker/mic";
import { type MicState, type OnAir, onAirState } from "../speaker/onair";
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
  const [view] = useRoom(watcher, room);

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
  const [now, setNow] = useState(0);
  const [liveAtStart, setLiveAtStart] = useState(false);
  const [announcedSinceStart, setAnnouncedSinceStart] = useState(false);
  const teacherLive = view?.teacherLive ?? false;
  const prevTeacherLive = useRef(teacherLive);

  useEffect(() => {
    if (teacherLive && !prevTeacherLive.current && mic !== "off") setAnnouncedSinceStart(true);
    prevTeacherLive.current = teacherLive;
  }, [teacherLive, mic]);

  useEffect(() => {
    if (mic === "off") return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [mic]);

  useEffect(() => () => micHandle.current?.close(), []);

  const startMicrophone = async () => {
    if (!publisher) return;
    setMic("starting");
    setMicError(undefined);
    setLiveAtStart(teacherLive);
    setAnnouncedSinceStart(false);
    setStartedAt(Date.now());
    setNow(Date.now());
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
    teacherLive,
    announcedSinceStart,
    liveAtStart,
    elapsedMs: now - startedAt,
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
          {mic === "off" || mic === "error" ? (
            <Button label="Go on air" variant="primary" isDisabled={!publisher} clickAction={startMicrophone} />
          ) : (
            <Button label="Stop" variant="destructive" onClick={stopMicrophone} />
          )}
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

function Roster({ agents }: { agents: readonly AgentView[] }) {
  const total = agents.reduce((sum, a) => sum + a.costUsd, 0);
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
              <th scope="col">Track</th>
              <th scope="col">Model</th>
              <th scope="col">Health</th>
              <th scope="col" className="num">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.name}>
                <th scope="row">
                  {a.label}
                  <div className="muted small">
                    {a.name}
                    {a.instance ? ` · instance ${a.instance}` : ""}
                  </div>
                </th>
                <td>{a.model ?? "—"}</td>
                <td>
                  <HealthDot health={a.health} />
                </td>
                <td className="num">{usd(a.costUsd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>
                Total
              </th>
              <td className="num">{usd(total)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

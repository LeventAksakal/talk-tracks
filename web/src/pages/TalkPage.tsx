import { useMemo, useState } from "react";
import { isValidRoom, slidesPath } from "../contracts/names";
import { useLocation } from "../router";
import { localEpoch } from "../speaker/clock";
import { Console, type ConsoleDeps } from "../speaker/Console";
import { openPdf } from "../speaker/deck";
import { createSpeakerMedia } from "../speaker/media";
import { moqBroadcast } from "../speaker/sink";
import { useMoqTransport } from "../transport/useTransport";
import { NotFound } from "./NotFound";

/**
 * The speaker console (ui-design §7) at /talk/<room>?token=…: microphone, camera and a PDF deck with
 * pen, highlighter, text marks and laser, published as the room's tracks. In development,
 * `?clock=local` stands in for the room service's clock, so slides go out with no room service.
 */
export function TalkPage({ room }: { room: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const token = params.get("token") ?? undefined;
  const localClock = import.meta.env.DEV && params.get("clock") === "local";
  if (!isValidRoom(room)) return <NotFound what={`"${room}" is not a room name.`} />;
  return <LiveConsole room={room} token={token} localClock={localClock} />;
}

function LiveConsole({ room, token, localClock }: { room: string; token: string | undefined; localClock: boolean }) {
  // Two connections: the publisher carries the token; the watcher is anonymous, like any viewer, so
  // what it sees is what the relay really accepted.
  const publisher = useMoqTransport(token);
  const watcher = useMoqTransport();
  const [epoch] = useState(() => (localClock ? localEpoch(Date.now()) : undefined));
  const deps = useMemo<ConsoleDeps | undefined>(
    () =>
      publisher && watcher
        ? {
            publisherStatus: publisher,
            watcher,
            makeSink: () => moqBroadcast(publisher.origin, slidesPath(room)),
            openDeck: openPdf,
            createMedia: () => createSpeakerMedia(publisher, room),
            localEpochMs: epoch,
          }
        : undefined,
    [publisher, watcher, room, epoch],
  );
  if (!deps) return <p className="page-pad muted">Connecting to the relay…</p>;
  return <Console room={room} token={token} deps={deps} />;
}

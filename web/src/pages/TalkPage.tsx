import { useMemo, useState } from "react";
import { RoomServiceClient, roomServiceBase } from "../annotate/client";
import { Loading } from "../brand/states";
import { RELAY_URL } from "../config";
import { isValidRoom, slidesPath } from "../contracts/names";
import { useLocation } from "../router";
import { localEpoch } from "../speaker/clock";
import { Console, type ConsoleDeps } from "../speaker/Console";
import { openSlides } from "../speaker/slideFiles";
import { createSpeakerMedia } from "../speaker/media";
import { forgetToken, speakerToken } from "../speaker/savedToken";
import { relayNeedsToken } from "../speaker/token";
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
  // The link's token is kept for this room, so a reload without it still opens the console (savedToken.ts).
  const token = useMemo(() => {
    const fromLink = new URLSearchParams(search).get("token") ?? undefined;
    return isValidRoom(room) ? speakerToken(room, fromLink) : undefined;
  }, [room, search]);
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
            openDeck: openSlides,
            createMedia: () => createSpeakerMedia(publisher, room),
            localEpochMs: epoch,
            // The speaker's session proves itself with the relay token; a local relay needs none, and the local
            // room service (TT_OPEN_SPEAKER) takes any, so the console still gets the speaker's rights there.
            makeRoomService: (name) =>
              new RoomServiceClient(roomServiceBase(), room, { token: token ?? "local", name, comments: true }),
            // A finished talk's link is not kept: the next visit to /talk/<room> needs the link again.
            onEnded: () => forgetToken(room),
            tokenRequired: relayNeedsToken(RELAY_URL),
          }
        : undefined,
    [publisher, watcher, room, epoch, token],
  );
  if (!deps) return <Loading>Connecting to the relay…</Loading>;
  return <Console room={room} token={token} deps={deps} />;
}

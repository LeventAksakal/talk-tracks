import { useEffect } from "react";
import { RoomServiceClient, roomServiceBase } from "../annotate/client";
import { Loading } from "../brand/states";
import { isValidRoom } from "../contracts/names";
import { RoomMedia } from "../playback/media";
import { MoqHistorySource } from "../playback/moqSource";
import { usePlayback } from "../playback/usePlayback";
import { Player } from "../player/Player";
import { SlideTracks } from "../player/slideTracks";
import { MoqTransport } from "../transport/moq";
import { useMoqTransport } from "../transport/useTransport";
import { useResource } from "../useResource";
import { DEMO_CREDIT, DEMO_NO_ROOM_SERVICE, demoRoom, lectureOf } from "./demoRooms";
import { NotFound } from "./NotFound";
import { rememberRoom } from "./recentRooms";

export function WatchPage({ room }: { room: string }) {
  if (!isValidRoom(room)) return <NotFound what={`"${room}" is not a room name.`} />;
  return <WatchRoom room={room} />;
}

/**
 * The player on a room of the relay: speaker media live and from the archive, the AI tracks over MoQ, and the
 * speaker's slides, ink, marks and laser with everyone's annotations and the room's state (decision 0022: live on
 * the speaker's tracks, the past from talk/<room>/archive/slides).
 */
function WatchRoom({ room }: { room: string }) {
  const transport = useMoqTransport();
  const playback = usePlayback(transport, room);
  const slides = useResource(() => {
    if (!(transport instanceof MoqTransport) || !playback) return undefined;
    const media = playback.media instanceof RoomMedia ? playback.media : undefined;
    return new SlideTracks(new MoqHistorySource(transport), room, { catalog: () => media?.catalog() });
  }, [transport, playback, room]);
  // Listeners draw, mark, comment and chat through the room service (decision 0024), never the relay. In a looped
  // demo room it takes chat only (archive.looped), so the threads are not asked for there.
  const demo = demoRoom(room);
  // A demo lecture's live session or its recording (decision 0032): either way the lecture's title and credit.
  const lecture = lectureOf(room)?.lecture;
  const roomService = useResource(
    () => new RoomServiceClient(roomServiceBase(), room, { comments: !demo }),
    [room, demo],
  );
  // The hub lists it under "Continue watching".
  useEffect(() => rememberRoom({ room, title: lecture?.title, at: Date.now() }), [room, lecture]);
  if (!playback)
    return (
      <main id="main">
        <Loading>Connecting…</Loading>
      </main>
    );
  return (
    <Player
      playback={playback}
      room={room}
      transport={transport}
      slides={slides}
      roomService={roomService}
      title={lecture?.title}
      speaker={lecture?.speaker}
      credit={lecture ? DEMO_CREDIT : undefined}
      noRoomService={demo ? DEMO_NO_ROOM_SERVICE : undefined}
      looped={demo !== undefined}
    />
  );
}

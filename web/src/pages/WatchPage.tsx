import { RoomServiceClient, roomServiceBase } from "../annotate/client";
import { isValidRoom } from "../contracts/names";
import { RoomMedia } from "../playback/media";
import { MoqHistorySource } from "../playback/moqSource";
import { usePlayback } from "../playback/usePlayback";
import { Player } from "../player/Player";
import { SlideTracks } from "../player/slideTracks";
import { MoqTransport } from "../transport/moq";
import { useMoqTransport } from "../transport/useTransport";
import { useResource } from "../useResource";
import { NotFound } from "./NotFound";

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
  // Listeners draw, mark and comment through the room service (decision 0024), never the relay.
  const roomService = useResource(
    () => new RoomServiceClient(roomServiceBase(), room, { comments: true }),
    [room],
  );
  if (!playback) return <p className="page-pad">Connecting…</p>;
  return <Player playback={playback} room={room} transport={transport} slides={slides} roomService={roomService} />;
}

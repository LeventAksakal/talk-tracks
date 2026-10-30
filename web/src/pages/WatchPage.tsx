import { isValidRoom } from "../contracts/names";
import { usePlayback } from "../playback/usePlayback";
import { Player } from "../player/Player";
import { useMoqTransport } from "../transport/useTransport";
import { NotFound } from "./NotFound";

export function WatchPage({ room }: { room: string }) {
  if (!isValidRoom(room)) return <NotFound what={`"${room}" is not a room name.`} />;
  return <WatchRoom room={room} />;
}

/** The player on a room of the relay: speaker media live and from the archive, the AI tracks over MoQ. */
function WatchRoom({ room }: { room: string }) {
  const transport = useMoqTransport();
  const playback = usePlayback(transport, room);
  if (!playback) return <p className="page-pad">Connecting…</p>;
  return <Player playback={playback} room={room} transport={transport} />;
}

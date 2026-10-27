import { isValidRoom } from "../contracts/names";
import { useMoqTransport } from "../transport/useTransport";
import { Viewer } from "../viewer/Viewer";
import { NotFound } from "./NotFound";

export function WatchPage({ room }: { room: string }) {
  const transport = useMoqTransport();
  if (!isValidRoom(room)) return <NotFound what={`"${room}" is not a room name.`} />;
  return <Viewer transport={transport} room={room} />;
}

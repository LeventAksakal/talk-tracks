// Which rooms are on air, for the lobby's badges: one announcement watch on the whole `talk/` prefix. Watching
// announcements subscribes to no track, so no agent works for it (decision 0010).

import { ROOT } from "../contracts/names";
import type { Closable, Transport } from "../transport/types";

/** Per room: true while its speaker broadcast (talk/<room>/teacher) is announced; undefined: not known yet. */
export type LiveRooms = ReadonlyMap<string, boolean> | undefined;

export function watchLiveRooms(
  transport: Transport,
  rooms: readonly string[],
  onChange: (live: LiveRooms) => void,
): Closable {
  const announced = new Set<string>();
  const emit = () => {
    if (transport.status() !== "connected") {
      onChange(undefined);
      return;
    }
    onChange(new Map(rooms.map((r) => [r, announced.has(`${r}/teacher`)])));
  };
  const sub = transport.announced(ROOT, ({ path, active }) => {
    if (active) announced.add(path);
    else announced.delete(path);
    emit();
  });
  const status = transport.onStatus(emit);
  emit();
  return {
    close() {
      sub.close();
      status.close();
    },
  };
}

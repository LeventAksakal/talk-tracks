// Which rooms are on air, for the hub: one announcement watch on the whole `talk/` prefix. Watching
// announcements subscribes to no track, so no agent works for it (decision 0010).

import { ROOT } from "../contracts/names";
import type { Closable, ConnectionStatus, Transport } from "../transport/types";

/** What the relay says: its connection, and the rooms whose speaker broadcast (talk/<room>/teacher) is announced. */
export interface RelayRooms {
  status: ConnectionStatus;
  /** Rooms on air now; only meaningful while connected. */
  live: ReadonlySet<string>;
}

const TEACHER = /^([^/]+)\/teacher$/;

export function watchRelayRooms(transport: Transport, onChange: (rooms: RelayRooms) => void): Closable {
  const live = new Set<string>();
  const emit = () => onChange({ status: transport.status(), live: new Set(live) });
  const sub = transport.announced(ROOT, ({ path, active }) => {
    const room = TEACHER.exec(path)?.[1];
    if (!room) return;
    if (active) live.add(room);
    else live.delete(room);
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

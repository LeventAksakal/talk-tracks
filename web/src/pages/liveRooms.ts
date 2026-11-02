// Which rooms are on air, for the hub: the speaker broadcasts (`talk/<room>/teacher`) the relay announces. Watching
// announcements subscribes to no track, so no agent works for it (decision 0010).
//
// The hub reads them through its own narrow connection (teacherAnnouncements.ts), whose origin keeps only teacher
// paths, and coalesces each burst of announcements into one update: the relay announces every broadcast of every
// room at connect, and handling each one on its own was the hub's one long task (QA run on d8175cf: TBT 570 ms).

import { ROOT } from "../contracts/names";
import type { AnnounceEvent, Closable, ConnectionStatus } from "../transport/types";

/** What the relay says: its connection, and the rooms whose speaker broadcast (talk/<room>/teacher) is announced. */
export interface RelayRooms {
  status: ConnectionStatus;
  /** Rooms on air now; only meaningful while connected. */
  live: ReadonlySet<string>;
}

/** What the hub needs of a relay connection; a Transport is one, and so is the hub's own narrow watch. */
export interface AnnounceSource {
  announced(prefix: string, onEvent: (event: AnnounceEvent) => void): Closable;
  status(): ConnectionStatus;
  onStatus(listener: (status: ConnectionStatus) => void): Closable;
}

const TEACHER = /^([^/]+)\/teacher$/;

/** How long a burst of announcements may gather before the hub updates, ms. */
export const COALESCE_MS = 50;

export function watchRelayRooms(source: AnnounceSource, onChange: (rooms: RelayRooms) => void): Closable {
  const live = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const flush = () => {
    timer = undefined;
    if (!closed) onChange({ status: source.status(), live: new Set(live) });
  };
  const later = () => {
    timer ??= setTimeout(flush, COALESCE_MS);
  };
  const sub = source.announced(ROOT, ({ path, active }) => {
    const room = TEACHER.exec(path)?.[1];
    if (!room) return;
    if (active === live.has(room)) return;
    if (active) live.add(room);
    else live.delete(room);
    later();
  });
  // A status change is shown at once; a burst of rooms that came with it lands in the same update.
  const status = source.onStatus(() => {
    clearTimeout(timer);
    flush();
  });
  flush();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      sub.close();
      status.close();
    },
  };
}

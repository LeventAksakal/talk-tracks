// What a room has on air, from announcements alone: the connection, the speaker's broadcasts, and the
// agents that publish. Watching announcements subscribes to nothing, so it costs no agent any work
// (decision 0010).

import { useEffect, useState } from "react";
import { ROOT } from "../contracts/names";
import type { ConnectionStatus, Transport } from "../transport/types";
import { parseAgentPath } from "./wire";

export interface RoomStatus {
  status: ConnectionStatus;
  /** talk/<room>/teacher is announced. */
  teacherLive: boolean;
  /** talk/<room>/slides is announced. */
  slidesLive: boolean;
  /** Agents announced under talk/<room>/agents, by name. */
  agents: readonly string[];
}

export function watchRoomStatus(
  transport: Transport,
  room: string,
  onChange: (status: RoomStatus) => void,
): { close(): void } {
  const announced = new Set<string>();
  let status = transport.status();
  const emit = () => {
    const agents: string[] = [];
    for (const path of announced) {
      const rel = path.startsWith("agents/") ? parseAgentPath(path.slice("agents/".length)) : null;
      if (rel) agents.push(rel);
    }
    onChange({
      status,
      teacherLive: announced.has("teacher"),
      slidesLive: announced.has("slides"),
      agents: agents.sort(),
    });
  };
  const sub = transport.announced(`${ROOT}/${room}`, ({ path, active }) => {
    if (active) announced.add(path);
    else announced.delete(path);
    emit();
  });
  const statusSub = transport.onStatus((s) => {
    status = s;
    emit();
  });
  emit();
  return {
    close() {
      sub.close();
      statusSub.close();
    },
  };
}

export function useRoomStatus(transport: Transport | undefined, room: string): RoomStatus | undefined {
  const [view, setView] = useState<RoomStatus>();
  useEffect(() => {
    if (!transport) return;
    const w = watchRoomStatus(transport, room, setView);
    return () => w.close();
  }, [transport, room]);
  return view;
}

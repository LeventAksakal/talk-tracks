// The rooms this browser opened lately, for the hub's "Continue watching": kept in this browser only (no account).

export interface RecentRoom {
  room: string;
  /** The talk's title when the page knew it, else undefined (the hub shows the room name). */
  title?: string;
  /** When it was last opened, ms since the epoch. */
  at: number;
}

export const RECENT_KEY = "tt.recent.v1";
const KEEP = 6;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readRecent(store: Pick<Storage, "getItem"> | undefined = storage()): RecentRoom[] {
  try {
    const v: unknown = JSON.parse(store?.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.flatMap((x: unknown) => {
      if (!x || typeof x !== "object") return [];
      const o = x as Record<string, unknown>;
      if (typeof o.room !== "string" || typeof o.at !== "number") return [];
      return [{ room: o.room, title: typeof o.title === "string" ? o.title : undefined, at: o.at }];
    });
  } catch {
    return [];
  }
}

/** Put a room first in the list (most recent first, at most KEEP). */
export function rememberRoom(
  entry: RecentRoom,
  store: Pick<Storage, "getItem" | "setItem"> | undefined = storage(),
): void {
  const rest = readRecent(store).filter((r) => r.room !== entry.room);
  try {
    store?.setItem(RECENT_KEY, JSON.stringify([entry, ...rest].slice(0, KEEP)));
  } catch {
    // private mode or storage full: nothing to continue next time
  }
}

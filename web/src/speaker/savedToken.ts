// The speaker link survives a reload: the token from /talk/<room>?token=… is kept in this browser per room, so
// reloading /talk/<room> without it (a refreshed tab, a link typed again) still opens the console as the speaker.
// End talk forgets it. A kept token that expired, is damaged or names another room is dropped, never used. Storage
// can be missing or throw (private windows, blocked storage): then only the link's own token works.

import { checkToken } from "./token";

const key = (room: string) => `tt.speaker.token.${room}`;

function read(room: string): string | undefined {
  try {
    return localStorage.getItem(key(room)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function forgetToken(room: string): void {
  try {
    localStorage.removeItem(key(room));
  } catch {
    // nothing kept
  }
}

function remember(room: string, token: string): void {
  try {
    localStorage.setItem(key(room), token);
  } catch {
    // not kept: the link's token still works this time
  }
}

/** The speaker token for this room: the link's (and keep it), else the one this browser kept, if still good. */
export function speakerToken(room: string, fromLink: string | undefined, nowMs = Date.now()): string | undefined {
  if (fromLink) {
    remember(room, fromLink);
    return fromLink;
  }
  const kept = read(room);
  if (!kept) return undefined;
  const check = checkToken(kept, room, nowMs);
  if (check.kind === "ok") return kept;
  forgetToken(room);
  return undefined;
}

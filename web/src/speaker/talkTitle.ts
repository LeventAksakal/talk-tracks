// The talk's title as the speaker typed it in Start a talk, kept in this browser so the console's header can say it
// (the room service keeps it too, but the console has no read of it yet). Absent: the console names the room.

const key = (room: string) => `tt.talk.title.${room}`;

export function rememberTitle(room: string, title: string): void {
  try {
    localStorage.setItem(key(room), title);
  } catch {
    // not kept: the console names the room instead
  }
}

export function titleOf(room: string): string | undefined {
  try {
    return localStorage.getItem(key(room)) || undefined;
  } catch {
    return undefined;
  }
}

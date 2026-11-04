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

const NAME_KEY = "tt.speaker.name";

/** The speaker's name as typed in Start a talk: the console signs the speaker's ink and avatar with it. */
export function rememberSpeakerName(name: string): void {
  try {
    if (name.trim()) localStorage.setItem(NAME_KEY, name.trim().slice(0, 60));
  } catch {
    // not kept: the console says "Speaker"
  }
}

export function speakerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || "Speaker";
  } catch {
    return "Speaker";
  }
}

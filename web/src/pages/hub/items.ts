// What the hub shows, as plain data: the rows and the hero, from what the relay has on air, the archive's
// recordings and this browser's recent rooms. No React here, so the rules are tested on their own.

import {
  DEMO_CREDIT,
  DEMO_LANGUAGES,
  DEMO_ROOMS,
  DEMO_TRACKS,
  type DemoRoom,
  type Language,
  type LectureArt,
  lectureOf,
  recordingRoom,
} from "../demoRooms";
import type { RelayRooms } from "../liveRooms";
import type { Recording } from "../recordings";
import type { RecentRoom } from "../recentRooms";

/** A live session of a demo lecture, a recording, or a talk a speaker gives now. */
export type ItemKind = "live" | "recording" | "talk";

export interface HubItem {
  /** The room the card opens. */
  room: string;
  kind: ItemKind;
  title: string;
  speaker?: string;
  description?: string;
  subject?: string;
  minutes?: number;
  /** On air now: true or false once the relay answered, undefined before. A recording is never on air. */
  onAir?: boolean;
  art?: LectureArt;
  credit?: string;
  languages: readonly Language[];
  tracks: readonly string[];
  /** The same lecture's other version: its recording from a live session, its live session from a recording. */
  also?: { kind: "live" | "recording"; room: string };
}

export interface HubRows {
  /** Talks on air, then the demo lectures' live sessions. */
  live: HubItem[];
  recordings: HubItem[];
  recent: HubItem[];
  /** What the hero cycles through: what is on air, else every live session. */
  featured: HubItem[];
}

/** The tracks any talk carries: captions, translations, slide descriptions, chapters and a glossary. */
const TALK_TRACKS = DEMO_TRACKS;

function lectureItem(lecture: DemoRoom, kind: "live" | "recording", recordings: ReadonlySet<string>): HubItem {
  const recorded = recordings.has(recordingRoom(lecture.room));
  return {
    room: kind === "live" ? lecture.room : recordingRoom(lecture.room),
    kind,
    title: lecture.title,
    speaker: lecture.speaker,
    description: lecture.description,
    subject: lecture.subject,
    minutes: lecture.minutes,
    art: lecture.art,
    credit: DEMO_CREDIT,
    languages: DEMO_LANGUAGES,
    tracks: DEMO_TRACKS,
    also:
      kind === "live"
        ? recorded
          ? { kind: "recording", room: recordingRoom(lecture.room) }
          : undefined
        : { kind: "live", room: lecture.room },
  };
}

function talkItem(room: string, title?: string): HubItem {
  return { room, kind: "talk", title: title ?? room, languages: [], tracks: TALK_TRACKS };
}

/** The item for any room the hub knows of by name (Continue watching). */
export function itemFor(room: string, recordings: ReadonlySet<string>, title?: string): HubItem {
  const known = lectureOf(room);
  return known ? lectureItem(known.lecture, known.kind, recordings) : talkItem(room, title);
}

export function hubRows({
  relay,
  recordings,
  recent,
}: {
  relay: RelayRooms | undefined;
  /** undefined while the archive's list is loading. */
  recordings: readonly Recording[] | undefined;
  recent: readonly RecentRoom[];
}): HubRows {
  const connected = relay?.status === "connected";
  const onAir = (room: string) => (connected ? relay.live.has(room) : undefined);
  const recorded = new Set((recordings ?? []).map((r) => r.room));

  const talks = connected
    ? [...relay.live]
        .filter((room) => !lectureOf(room))
        .sort()
        .map((room) => ({ ...talkItem(room), onAir: true }))
    : [];
  const sessions = DEMO_ROOMS.map((d) => ({ ...lectureItem(d, "live", recorded), onAir: onAir(d.room) }));
  // Sessions on air first; the order of DEMO_ROOMS otherwise.
  const live = [...talks, ...sessions.filter((s) => s.onAir), ...sessions.filter((s) => !s.onAir)];

  const order = (r: Recording) => {
    const i = DEMO_ROOMS.findIndex((d) => d.room === r.of);
    return i < 0 ? DEMO_ROOMS.length : i;
  };
  const recs = [...(recordings ?? [])]
    .sort((a, b) => order(a) - order(b))
    .map((r) => {
      const known = lectureOf(r.room);
      return known
        ? lectureItem(known.lecture, "recording", recorded)
        : { ...talkItem(r.room, r.of), kind: "recording" as const };
    });

  const recentItems = recent.map((r) => {
    const item = itemFor(r.room, recorded, r.title);
    return item.kind === "recording" ? item : { ...item, onAir: onAir(r.room) };
  });

  const onAirNow = live.filter((i) => i.onAir);
  return { live, recordings: recs, recent: recentItems, featured: onAirNow.length ? onAirNow : sessions };
}

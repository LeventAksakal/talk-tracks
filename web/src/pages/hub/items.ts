// What the hub shows, as plain data: the rows and the hero, from what the relay has on air, the archive's
// recordings and this browser's recent rooms. No React here, so the rules are tested on their own.

import {
  DEMO_CREDIT,
  DEMO_ROOMS,
  DEMO_SPOKEN,
  DEMO_TRACKS,
  type DemoRoom,
  type Language,
  type LectureStill,
  lectureOf,
  recordingRoom,
  SUBTITLE_LANGUAGE_COUNT,
} from "../demoRooms";
import type { CommunityRoom } from "../communityRooms";
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
  /** A frame of the lecture's own recording; a talk without one shows its title on a plain field. */
  still?: LectureStill;
  /** A talk's own first slide, from the archive (an /archive/ path), shown when it has no lecture still. */
  slide?: string;
  credit?: string;
  /** The language the talk is spoken in, when known. */
  spoken?: Language;
  /** How many languages it can be subtitled in, each translated on first pick. */
  subtitleLanguages: number;
  tracks: readonly string[];
  /** The same lecture's other version: its recording from a live session, its live session from a recording. */
  also?: { kind: "live" | "recording"; room: string };
}

export interface HubRows {
  /** Talks speakers give now, then the demo lectures' live sessions apart from the hero's. */
  live: HubItem[];
  /** One card a recording; the demo lectures' from the first paint, until the archive's list says otherwise. */
  recordings: HubItem[];
  recent: HubItem[];
  /** The hero's talk: the first demo lecture's live session, always, so the first paint never changes. */
  featured: HubItem | undefined;
}

/** A title and its subtitle, split at the first colon: "You Are Part Virus" over "How Biological Viruses Hack Cells". */
export function splitTitle(title: string): [string, string | undefined] {
  const at = title.indexOf(": ");
  return at > 0 ? [title.slice(0, at), title.slice(at + 2)] : [title, undefined];
}

/** The tracks any talk carries: captions, translations, slide descriptions, chapters and a glossary. */
const TALK_TRACKS = DEMO_TRACKS;

/** `recordings` undefined: the archive's list is loading, and a demo lecture is taken to have its recording. */
function lectureItem(
  lecture: DemoRoom,
  kind: "live" | "recording",
  recordings: ReadonlySet<string> | undefined,
): HubItem {
  const recorded = recordings ? recordings.has(recordingRoom(lecture.room)) : true;
  return {
    room: kind === "live" ? lecture.room : recordingRoom(lecture.room),
    kind,
    title: lecture.title,
    speaker: lecture.speaker,
    description: lecture.description,
    subject: lecture.subject,
    minutes: lecture.minutes,
    still: lecture.stills[kind],
    credit: DEMO_CREDIT,
    spoken: DEMO_SPOKEN,
    subtitleLanguages: SUBTITLE_LANGUAGE_COUNT,
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
  return { room, kind: "talk", title: title ?? room, subtitleLanguages: SUBTITLE_LANGUAGE_COUNT, tracks: TALK_TRACKS };
}

/** A room a presenter made (GET /api/rooms): its title, speaker, length and first slide. */
function communityItem(r: CommunityRoom, kind: "talk" | "recording"): HubItem {
  return {
    ...talkItem(r.room, r.title),
    kind,
    speaker: r.speaker,
    minutes: r.durationS ? Math.max(1, Math.round(r.durationS / 60)) : undefined,
    slide: r.still,
  };
}

/** The item for any room the hub knows of by name (Continue watching). */
export function itemFor(room: string, recordings: ReadonlySet<string> | undefined, title?: string): HubItem {
  const known = lectureOf(room);
  return known ? lectureItem(known.lecture, known.kind, recordings) : talkItem(room, title);
}

export function hubRows({
  relay,
  recordings,
  recent,
  community = [],
}: {
  relay: RelayRooms | undefined;
  /** undefined while the archive's list is loading. */
  recordings: readonly Recording[] | undefined;
  recent: readonly RecentRoom[];
  /** The rooms presenters made (GET /api/rooms); [] while loading or when the room service is out of reach. */
  community?: readonly CommunityRoom[];
}): HubRows {
  const connected = relay?.status === "connected";
  const onAir = (room: string) => (connected ? relay.live.has(room) : undefined);
  const recorded = recordings ? new Set(recordings.map((r) => r.room)) : undefined;
  const made = new Map(community.filter((r) => !lectureOf(r.room)).map((r) => [r.room, r]));

  // On air: what the room service says is live (newest first), then what the relay announces that the room service
  // has not ended (a talk it does not know, or one that went on air since its list was made).
  const newest = (a: CommunityRoom, b: CommunityRoom) => (b.started ?? 0) - (a.started ?? 0);
  const saidLive = [...made.values()].filter((r) => r.state === "live").sort(newest);
  const announced = connected
    ? [...relay.live]
        .filter((room) => !lectureOf(room) && made.get(room)?.state !== "live" && made.get(room)?.state !== "ended")
        .sort()
    : [];
  const talks = [
    ...saidLive.map((r) => ({ ...communityItem(r, "talk"), onAir: true })),
    ...announced.map((room) => {
      const known = made.get(room);
      return { ...(known ? communityItem(known, "talk") : talkItem(room)), onAir: true };
    }),
  ];
  const sessions = DEMO_ROOMS.map((d) => ({ ...lectureItem(d, "live", recorded), onAir: onAir(d.room) }));

  const order = (r: Recording) => {
    const i = DEMO_ROOMS.findIndex((d) => d.room === r.of);
    return i < 0 ? DEMO_ROOMS.length : i;
  };
  const recs = recordings
    ? [...recordings]
        .sort((a, b) => order(a) - order(b))
        .map((r) => {
          const known = lectureOf(r.room);
          return known
            ? lectureItem(known.lecture, "recording", recorded)
            : { ...talkItem(r.room, r.of), kind: "recording" as const };
        })
    : DEMO_ROOMS.map((d) => lectureItem(d, "recording", recorded));
  // The talks presenters gave, after the demo lectures (so nothing on the first paint moves), newest first.
  const talksRecorded = [...made.values()]
    .filter((r) => r.state === "ended" && r.recording)
    .sort((a, b) => (b.ended ?? b.started ?? 0) - (a.ended ?? a.started ?? 0))
    .map((r) => communityItem(r, "recording"));

  const recentItems = recent.map((r) => {
    const item = itemFor(r.room, recorded, r.title);
    return item.kind === "recording" ? item : { ...item, onAir: onAir(r.room) };
  });

  const [featured, ...others] = sessions;
  return { live: [...talks, ...others], recordings: [...recs, ...talksRecorded], recent: recentItems, featured };
}

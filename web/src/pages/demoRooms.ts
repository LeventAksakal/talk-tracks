// The four demo lectures (wiki/howto/demo-rooms.md): EMF 2026 talks, CC BY-SA 4.0, credited in the README. Each is
// two rooms (decision 0032): a live session on `talk/<room>` that plays the lecture once from 00:00, ends and starts
// again, and a recording, the archived room `<room>-recording`. Titles and speakers as credited; the descriptions
// are ours.

import languageList from "../../../contracts/languages.json";
import { RECORDING_SUFFIX, recordingOf } from "../contracts/names";

/**
 * A lecture's picture on its card and in the hero: one frame of its own recording (decision 0036), a slide the
 * speaker made or the speaker on stage, cropped to 16:9 and kept in web/public/talks/ at two widths. Slides that
 * show other people's images are not used (ticket 0001).
 */
export interface LectureStill {
  /** The files, `/talks/<stem>-480.webp` and `/talks/<stem>-<wide>.webp`. */
  stem: string;
  /** Width of the larger file, px (the source frame is 720p, so a slide crop is narrower than 960). */
  wide: number;
  /** What it shows, for its credit line. */
  shows: "slide" | "stage" | "camera";
}

/** The still's two files, as an img srcset, and its small file as the fallback src. */
export function stillSources(still: LectureStill): { src: string; srcSet: string } {
  const small = `/talks/${still.stem}-480.webp`;
  return { src: small, srcSet: `${small} 480w, /talks/${still.stem}-${still.wide}.webp ${still.wide}w` };
}

/** The still's credit line: what it is, whose talk, and the licence. */
export function stillCredit(still: LectureStill, speaker: string): string {
  const what = { slide: "Slide from the talk", stage: "On stage", camera: "Speaking by video link" }[still.shows];
  return `${what} · ${speaker}, ${DEMO_CREDIT}`;
}

export interface DemoRoom {
  /** The live session's room; the recording is `recordingRoom(room)`. */
  room: string;
  title: string;
  speaker: string;
  /** The talk's page on media.ccc.de. */
  source: string;
  /** One or two sentences: what the talk is about. */
  description: string;
  subject: string;
  /** Length of the cut we play, whole minutes. */
  minutes: number;
  /** Its live session's still and its recording's: two frames, so the two rows do not repeat one picture. */
  stills: { live: LectureStill; recording: LectureStill };
}

export const DEMO_CREDIT = "EMF 2026 · CC BY-SA 4.0";

export interface Language {
  code: string;
  /** The language's own name. */
  name: string;
}

/** The language every demo lecture is spoken in. */
export const DEMO_SPOKEN: Language = { code: "en", name: "English" };

/**
 * How many languages any talk can be subtitled in: the one list in contracts/languages.json (decision 0035).
 * None is made in advance; each is translated when a viewer first picks it.
 */
export const SUBTITLE_LANGUAGE_COUNT: number = languageList.languages.length;

/** The AI tracks every demo lecture carries. */
export const DEMO_TRACKS: readonly string[] = [
  "Captions",
  "Translations",
  "Slide descriptions",
  "Chapters",
  "Glossary",
];

export const DEMO_ROOMS: readonly DemoRoom[] = [
  {
    room: "virus",
    title: "You Are Part Virus: How Biological Viruses Hack Cells",
    speaker: "Christopher Binny",
    source: "https://media.ccc.de/v/emf2026-149-1-you-are-part-virus-how-biological-viruses-hack-cells",
    description:
      "How a virus breaks into a cell, turns it into a factory for copies of itself, and gets out again, and how old infections left their mark in our own DNA.",
    subject: "Biology",
    minutes: 17,
    stills: {
      live: { stem: "virus", wide: 960, shows: "slide" },
      recording: { stem: "virus-rec", wide: 960, shows: "slide" },
    },
  },
  {
    room: "dataviz",
    title: "Data Visualisation: The Good, The Bad, The Ugly and the Beautiful",
    speaker: "Charlotte Rutherford",
    source: "https://media.ccc.de/v/emf2026-241-1-data-visualisation-the-good-the-bad-the-ugly",
    description:
      "A tour of charts that inform and charts that mislead, and the small design choices that make the difference.",
    subject: "Design",
    minutes: 19,
    stills: {
      live: { stem: "dataviz", wide: 960, shows: "camera" },
      recording: { stem: "dataviz-rec", wide: 960, shows: "slide" },
    },
  },
  {
    room: "rsa",
    title: "It's the End of RSA as We Know It (And I Feel Fine): An Introduction to Post-Quantum Cryptography",
    speaker: "Lucy Bell",
    source: "https://media.ccc.de/v/emf2026-242-1-its-the-end-of-rsa-as-we-know-it-and-i-feel-fine",
    description:
      "Why a large quantum computer would break today's public-key cryptography, and the lattice-based schemes being rolled out to replace it.",
    subject: "Computer science",
    minutes: 20,
    stills: {
      live: { stem: "rsa", wide: 960, shows: "slide" },
      recording: { stem: "rsa-rec", wide: 960, shows: "slide" },
    },
  },
  {
    room: "qrcode",
    title: "A Brief History of the QR Code, and other scannable things",
    speaker: "Jon Ginn",
    source: "https://media.ccc.de/v/emf2026-234-1-a-brief-history-of-the-qr-code-and-other-scannable-things",
    description:
      "From supermarket barcodes to the QR code: how scannable codes were invented, how they store data, and how they survive damage.",
    subject: "History",
    minutes: 16,
    stills: {
      live: { stem: "qrcode", wide: 848, shows: "stage" },
      recording: { stem: "qrcode-rec", wide: 960, shows: "stage" },
    },
  },
];

/** The archived room that holds a lecture's recording. */
export const recordingRoom = (room: string) => `${room}${RECORDING_SUFFIX}`;

/** The demo lecture whose live session is `room`. */
export function demoRoom(room: string): DemoRoom | undefined {
  return DEMO_ROOMS.find((d) => d.room === room);
}

/** The demo lecture a room belongs to, as its live session or its recording. */
export function lectureOf(room: string): { lecture: DemoRoom; kind: "live" | "recording" } | undefined {
  const live = demoRoom(room);
  if (live) return { lecture: live, kind: "live" };
  const id = recordingOf(room);
  const recorded = id ? demoRoom(id) : undefined;
  return recorded ? { lecture: recorded, kind: "recording" } : undefined;
}

/** What a demo room's Discussion tab says: in a demo lecture the room service takes chat only. */
export const DEMO_NO_ROOM_SERVICE =
  "This is a demo lecture, so drawing on slides, marking text and comments are off here; the chat is open. They work in a live talk.";

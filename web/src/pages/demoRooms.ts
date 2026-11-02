// The four demo lectures (wiki/howto/demo-rooms.md): EMF 2026 talks, CC BY-SA 4.0, credited in the README. Each is
// two rooms (decision 0032): a live session on `talk/<room>` that plays the lecture once from 00:00, ends and starts
// again, and a recording, the archived room `<room>-recording`. Titles and speakers as credited; the descriptions
// are ours.

/** What a card draws for a lecture: generated artwork, never a frame of the talk (its slides hold others' images). */
export type LectureArt = "virus" | "dataviz" | "rsa" | "qrcode";

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
  art: LectureArt;
}

export const DEMO_CREDIT = "EMF 2026 · CC BY-SA 4.0";

/** The languages a demo lecture carries without asking: the speaker's, then the pre-made translations. */
export interface Language {
  code: string;
  /** The language's own name. */
  name: string;
}
export const DEMO_LANGUAGES: readonly Language[] = [
  { code: "en", name: "English" },
  { code: "tr", name: "Türkçe" },
  { code: "es", name: "Español" },
  { code: "ar", name: "العربية" },
];

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
    art: "virus",
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
    art: "dataviz",
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
    art: "rsa",
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
    art: "qrcode",
  },
];

const RECORDING_SUFFIX = "-recording";

/** The archived room that holds a lecture's recording. */
export const recordingRoom = (room: string) => `${room}${RECORDING_SUFFIX}`;

/** The demo lecture whose live session is `room`. */
export function demoRoom(room: string): DemoRoom | undefined {
  return DEMO_ROOMS.find((d) => d.room === room);
}

/** For a `<id>-recording` room: the id, else undefined. */
export function recordingOf(room: string): string | undefined {
  return room.endsWith(RECORDING_SUFFIX) && room.length > RECORDING_SUFFIX.length
    ? room.slice(0, -RECORDING_SUFFIX.length)
    : undefined;
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

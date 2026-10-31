// The four public demo rooms (wiki/howto/demo-rooms.md): EMF 2026 talks, CC BY-SA 4.0, looped on the VM with AI
// tracks generated once. Titles and speakers as credited in the README.

export interface DemoRoom {
  room: string;
  title: string;
  speaker: string;
  /** The talk's page on media.ccc.de. */
  source: string;
}

export const DEMO_CREDIT = "EMF 2026 · CC BY-SA 4.0";

export const DEMO_ROOMS: readonly DemoRoom[] = [
  {
    room: "virus",
    title: "You Are Part Virus: How Biological Viruses Hack Cells",
    speaker: "Christopher Binny",
    source: "https://media.ccc.de/v/emf2026-149-1-you-are-part-virus-how-biological-viruses-hack-cells",
  },
  {
    room: "dataviz",
    title: "Data Visualisation: The Good, The Bad, The Ugly and the Beautiful",
    speaker: "Charlotte Rutherford",
    source: "https://media.ccc.de/v/emf2026-241-1-data-visualisation-the-good-the-bad-the-ugly",
  },
  {
    room: "rsa",
    title: "It's the End of RSA as We Know It (And I Feel Fine): An Introduction to Post-Quantum Cryptography",
    speaker: "Lucy Bell",
    source: "https://media.ccc.de/v/emf2026-242-1-its-the-end-of-rsa-as-we-know-it-and-i-feel-fine",
  },
  {
    room: "qrcode",
    title: "A Brief History of the QR Code, and other scannable things",
    speaker: "Jon Ginn",
    source: "https://media.ccc.de/v/emf2026-234-1-a-brief-history-of-the-qr-code-and-other-scannable-things",
  },
];

export function demoRoom(room: string): DemoRoom | undefined {
  return DEMO_ROOMS.find((d) => d.room === room);
}

/** What a demo room's Discussion tab says: a looped recording has no room service to draw or comment through. */
export const DEMO_NO_ROOM_SERVICE =
  "This is a looped demo lecture with no live room service, so drawing on slides, marking text and comments are off here. They work in a live talk.";

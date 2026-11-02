// The lecture package's files (wiki/spec/lecture-package.md, ticket 0023): a pure function of what was gathered,
// so what goes in the .zip is tested without a browser. Times in the package are talk time: ms from the start of
// the talk, as the player's clock shows it.

import type { Note } from "../player/notes";
import { notesMarkdown } from "../player/notes";
import { clockOf, exportTranscript, type TranscriptLanguage } from "../player/transcriptExport";
import type { Outline } from "../playback/wire";
import type { TextRun } from "../contracts/types";
import type { ShownSpan } from "./slides";
import type { ZipEntry } from "./zip";

export const PACKAGE_FORMAT = "talk-tracks/lecture-package";
export const PACKAGE_VERSION = 1;

export interface PackageSlide {
  /** 1-based position in its deck. */
  number: number;
  /** The deck track's group; a package of one deck names its slides by number only. */
  deck: number;
  text: string;
  /** Room ms. */
  shown: readonly ShownSpan[];
  ink: number;
  marks: number;
  png: Uint8Array | undefined;
}

export interface PackageInput {
  title: string;
  speaker: string | undefined;
  room: string;
  createdAt: Date;
  /** Room ms: what the package covers. */
  fromMs: number;
  toMs: number;
  /** The talk was still going: the package holds what happened so far. */
  live: boolean;
  /** Room ms to talk ms. */
  talkMs: (ms: number) => number;
  /** The original first, then translations. */
  languages: readonly TranscriptLanguage[];
  outline: Outline | undefined;
  slides: readonly PackageSlide[];
  notes: readonly Note[];
  /** Translations the room has that were not gathered (no agent was running for them), by name. */
  leftOut: readonly string[];
}

type Role =
  | "readme"
  | "lecture"
  | "transcript-vtt"
  | "transcript-md"
  | "chapters"
  | "glossary"
  | "slide-image"
  | "slide-text"
  | "notes";

interface FileOut {
  path: string;
  role: Role;
  mediaType: string;
  data: Uint8Array | string;
  lang?: string;
}

/** The slide's text from its text layer, a line break where a run starts a new line. */
export function slideText(runs: readonly TextRun[] | undefined): string {
  if (!runs?.length) return "";
  const lines: string[][] = [];
  let lastMid: number | undefined;
  let lastH = 0;
  for (const r of runs) {
    const mid = r.box.y + r.box.h / 2;
    if (lastMid === undefined || Math.abs(mid - lastMid) > Math.min(lastH, r.box.h) / 2) lines.push([]);
    lines.at(-1)!.push(r.text.trim());
    lastMid = mid;
    lastH = r.box.h;
  }
  return lines
    .map((l) => l.filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n");
}

const pad = (n: number) => String(n).padStart(2, "0");
const safeTag = (s: string) => s.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "und";

/** The file stem of a slide: 03, or d1-03 when the package holds more than one deck. */
export function slideStem(s: Pick<PackageSlide, "deck" | "number">, manyDecks: boolean): string {
  return manyDecks ? `d${s.deck}-${pad(s.number)}` : pad(s.number);
}

/** Every file of the package, manifest.json first. */
export function lectureFiles(input: PackageInput): ZipEntry[] {
  const files: FileOut[] = [];
  const at = (ms: number) => Math.max(0, Math.round(input.talkMs(ms)));
  const clock = (ms: number) => clockOf(input.talkMs(ms));
  const manyDecks = new Set(input.slides.map((s) => s.deck)).size > 1;
  const stem = (s: PackageSlide) => slideStem(s, manyDecks);

  // Transcripts, one pair of files per language.
  const used = new Set<string>();
  const languages = input.languages.map((l, i) => {
    let tag = safeTag(l.lang);
    while (used.has(tag)) tag = `${tag}-${i}`;
    used.add(tag);
    const one = { title: input.title, languages: [l], talkMs: input.talkMs };
    const vtt = `transcript/${tag}.vtt`;
    const md = `transcript/${tag}.md`;
    files.push({
      path: vtt,
      role: "transcript-vtt",
      mediaType: "text/vtt",
      data: exportTranscript("vtt", one),
      lang: l.lang,
    });
    files.push({
      path: md,
      role: "transcript-md",
      mediaType: "text/markdown",
      data: exportTranscript("md", one),
      lang: l.lang,
    });
    return {
      lang: l.lang,
      name: l.name,
      original: i === 0,
      lines: l.lines.filter((x) => x.final && x.text.trim()).length,
      files: [vtt, md],
    };
  });

  const chapters = (input.outline?.chapters ?? []).map((c, i, all) => ({
    number: i + 1,
    title: c.title,
    summary: c.summary,
    startMs: at(c.start_ms),
    endMs: at(all[i + 1]?.start_ms ?? input.toMs),
    start: clock(c.start_ms),
  }));
  files.push({
    path: "chapters.json",
    role: "chapters",
    mediaType: "application/json",
    data: json({ recap: input.outline?.recap ?? "", chapters }),
  });
  const glossary = (input.outline?.glossary ?? []).map((g) => ({ term: g.term, definition: g.definition }));
  files.push({ path: "glossary.json", role: "glossary", mediaType: "application/json", data: json(glossary) });

  // Slides: a picture with the ink baked in, and the text beside it.
  const slides = input.slides.map((s) => {
    const image = s.png ? `slides/${stem(s)}.png` : null;
    const text = `slides/${stem(s)}.md`;
    if (s.png) files.push({ path: image!, role: "slide-image", mediaType: "image/png", data: s.png });
    files.push({ path: text, role: "slide-text", mediaType: "text/markdown", data: slideMarkdown(s, clock, image) });
    return {
      number: s.number,
      deck: s.deck,
      image,
      text,
      shown: s.shown.map((x) => ({ startMs: at(x.fromMs), endMs: at(x.toMs) })),
      ink: s.ink,
      marks: s.marks,
    };
  });

  files.push({
    path: "notes.md",
    role: "notes",
    mediaType: "text/markdown",
    data: notesMarkdown(`${input.title}: my notes`, input.notes, clock),
  });
  files.push({ path: "lecture.md", role: "lecture", mediaType: "text/markdown", data: lectureMarkdown(input, stem) });
  files.push({ path: "README.md", role: "readme", mediaType: "text/markdown", data: readme(input) });

  const enc = new TextEncoder();
  const bytes = (d: Uint8Array | string) => (typeof d === "string" ? enc.encode(d).length : d.length);
  const manifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    createdAt: input.createdAt.toISOString(),
    lecture: {
      title: input.title,
      speaker: input.speaker ?? null,
      room: input.room,
      live: input.live,
      durationMs: Math.max(0, at(input.toMs) - at(input.fromMs)),
    },
    entry: "lecture.md",
    languages,
    leftOut: { languages: [...input.leftOut] },
    chapters: chapters.length,
    glossary: glossary.length,
    notes: input.notes.length,
    slides,
    files: files.map((f) => ({
      path: f.path,
      role: f.role,
      mediaType: f.mediaType,
      bytes: bytes(f.data),
      ...(f.lang ? { lang: f.lang } : {}),
    })),
  };
  return [{ path: "manifest.json", data: json(manifest) }, ...files.map((f) => ({ path: f.path, data: f.data }))];
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function slideMarkdown(s: PackageSlide, clock: (ms: number) => string, image: string | null): string {
  const lines = [`# Slide ${s.number}`, ""];
  if (s.shown.length) lines.push(`Shown at ${s.shown.map((x) => `${clock(x.fromMs)}–${clock(x.toMs)}`).join(", ")}.`);
  else lines.push("Not shown during the talk.");
  if (s.ink || s.marks)
    lines.push(`The speaker drew ${count(s.ink, "stroke")} and made ${count(s.marks, "text mark")} on it.`);
  if (image) lines.push(`Picture: ${image.replace(/^slides\//, "")}`);
  lines.push("", s.text || "(This slide has no text layer.)");
  return `${lines.join("\n")}\n`;
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Quote a block as Markdown: each line behind "> ". */
const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

/**
 * lecture.md: the whole lecture in one file an assistant can read on its own. Chapters are headings; under each,
 * the original transcript and, where a slide first appeared, the slide's text inline.
 */
function lectureMarkdown(input: PackageInput, stem: (s: PackageSlide) => string): string {
  const clock = (ms: number) => clockOf(input.talkMs(ms));
  const original = input.languages[0];
  const out: string[] = [`# ${input.title}`, ""];
  const facts = [
    input.speaker,
    `${clock(input.toMs)} long${input.live ? " so far (the talk was still going)" : ""}`,
    `downloaded ${input.createdAt.toISOString().slice(0, 10)}`,
  ].filter(Boolean);
  out.push(facts.join(" · "), "");
  out.push(
    "This file is the whole lecture: chapters as headings, the transcript under each with talk times (m:ss), " +
      "and each slide's text where it first appeared. The other files in this package hold the same material as " +
      "data; see README.md.",
    "",
  );
  if (input.outline?.recap) out.push("## Recap", "", input.outline.recap, "");

  type Event = { at: number; text: string };
  const lines: Event[] = (original?.lines ?? [])
    .filter((l) => l.final && l.text.trim())
    .map((l) => ({ at: l.startMs, text: `**${clock(l.startMs)}** ${l.text.trim()}` }));
  const firstShown = input.slides.filter((s) => s.shown.length).map((s) => ({ s, at: s.shown[0]!.fromMs }));
  const slideEvents: Event[] = firstShown.map(({ s, at }) => {
    const again = s.shown.slice(1).map((x) => clock(x.fromMs));
    const head = `**Slide ${s.number}** (shown at ${clock(at)}${again.length ? `, again at ${again.join(", ")}` : ""}; ${
      s.png ? `picture with the speaker's ink: slides/${stem(s)}.png` : "no picture"
    })`;
    return { at, text: quote([head, "", s.text || "(no text layer)"].join("\n")) };
  });
  const events = [...lines, ...slideEvents].sort((a, b) => a.at - b.at);

  const chapters = input.outline?.chapters ?? [];
  if (!chapters.length) {
    out.push("## Transcript", "");
    for (const e of events) out.push(e.text, "");
  } else {
    out.push("## Contents", "");
    chapters.forEach((c, i) => out.push(`${i + 1}. ${c.title} (${clock(c.start_ms)})`));
    out.push("");
    const before = events.filter((e) => e.at < chapters[0]!.start_ms);
    if (before.length) {
      out.push("## Before the first chapter", "");
      for (const e of before) out.push(e.text, "");
    }
    chapters.forEach((c, i) => {
      const end = chapters[i + 1]?.start_ms ?? Infinity;
      out.push(`## ${i + 1}. ${c.title}`, "", `*${clock(c.start_ms)}*${c.summary ? ` · ${c.summary}` : ""}`, "");
      for (const e of events) if (e.at >= c.start_ms && e.at < end) out.push(e.text, "");
    });
  }

  const unseen = input.slides.filter((s) => !s.shown.length && s.text);
  if (unseen.length) {
    out.push("## Slides not shown in the talk", "");
    for (const s of unseen) out.push(quote([`**Slide ${s.number}**`, "", s.text].join("\n")), "");
  }
  const glossary = input.outline?.glossary ?? [];
  if (glossary.length) {
    out.push("## Glossary", "");
    for (const g of glossary) out.push(`- **${g.term}**: ${g.definition}`);
    out.push("");
  }
  if (input.notes.length) {
    out.push("## My notes", "");
    for (const n of input.notes) {
      const where = `${clock(n.at)}${n.slide ? ` · slide ${n.slide}` : ""}`;
      out.push(n.text ? `- **${where}** ${n.text}` : `- **${where}** Bookmark`);
    }
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function readme(input: PackageInput): string {
  const names = input.languages.map((l) => l.name).join(", ");
  const parts = [
    `# Lecture package: ${input.title}`,
    "",
    "A lecture downloaded from Talk Tracks, for you (an AI assistant) to read and to help the listener with: answer " +
      "questions about it, explain parts of it, quiz them, or summarise it. Start with `lecture.md`; it holds the " +
      "whole lecture in one file. Use the other files when you need the data behind it.",
    "",
    "## Files",
    "",
    "- `lecture.md`: the lecture in reading order. Chapters are headings; the transcript in the original language " +
      "runs under each; a slide's text is quoted where the slide first appeared.",
    "- `manifest.json`: what is in the package: format and version, the lecture, languages, slides, and every file " +
      "with its role and size.",
    `- \`transcript/<lang>.vtt\` and \`transcript/<lang>.md\`: the transcript per language (${names || "none"}), ` +
      "as WebVTT subtitles and as Markdown. The first language in the manifest is the original; the others are " +
      "machine translations, matched to it line by line.",
    "- `chapters.json`: the chapters (title, summary, start and end) and a recap of the talk.",
    "- `glossary.json`: terms from the talk with definitions.",
    "- `slides/NN.png`: each slide as shown, with the speaker's ink and text marks drawn on it. `slides/NN.md` holds " +
      "the slide's text and when it was on screen. NN is the slide number in the deck.",
    "- `notes.md`: the listener's own notes and bookmarks, stamped with the talk time and slide.",
    "",
    "## How to read it",
    "",
    "- Times are talk time, from the start of the talk: m:ss in text, milliseconds in JSON.",
    "- The transcript, translations, chapters, summaries and glossary are machine-generated live during the talk. " +
      "They can mishear names and technical terms; when the slide text and the transcript disagree, the slide is " +
      "usually right.",
    "- The notes are the listener's. They show what the listener found important or was unsure about.",
  ];
  if (input.live) parts.push("- The talk was still going when this was downloaded: the package ends there.");
  if (input.leftOut.length)
    parts.push(
      `- The room also offers ${input.leftOut.join(", ")}, which were not running when this was downloaded and ` +
        "so are not included.",
    );
  return `${parts.join("\n")}\n`;
}

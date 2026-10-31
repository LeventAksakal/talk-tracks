// The transcript as a file (the side panel's Download): plain text, WebVTT subtitles or Markdown, in one language
// or every language the room offers. Lines are joined across languages by id (a translated cue keeps its
// caption's id). Times are talk time: the caller maps room ms to the talk's own clock.

import type { LineItem } from "../playback/wire";

export type TranscriptFormat = "txt" | "vtt" | "md";

export const TRANSCRIPT_FORMATS: readonly { format: TranscriptFormat; label: string; mime: string }[] = [
  { format: "txt", label: "Text (.txt)", mime: "text/plain" },
  { format: "vtt", label: "Subtitles (.vtt)", mime: "text/vtt" },
  { format: "md", label: "Markdown (.md)", mime: "text/markdown" },
];

export interface TranscriptLanguage {
  lang: string;
  /** How the file names it: "English (original)", "Español". */
  name: string;
  lines: readonly LineItem[];
}

export interface TranscriptInput {
  title: string;
  /** The first language leads; the others are matched to it by line id. */
  languages: readonly TranscriptLanguage[];
  /** Room ms to talk ms. */
  talkMs: (ms: number) => number;
}

interface Row {
  startMs: number;
  endMs: number;
  texts: { lang: string; text: string }[];
}

/** The rows of the file: the lead language's final lines in time order, each with the other languages' text. */
function rows({ languages }: TranscriptInput): Row[] {
  const [lead, ...rest] = languages;
  if (!lead) return [];
  const byId = rest.map((l) => ({ lang: l.lang, lines: new Map(l.lines.map((x) => [x.id, x] as const)) }));
  return lead.lines
    .filter((l) => l.final && l.text.trim())
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
    .map((l) => ({
      startMs: l.startMs,
      endMs: Math.max(l.endMs, l.startMs + 1),
      texts: [
        { lang: lead.lang, text: l.text.trim() },
        ...byId.flatMap((o) => {
          const t = o.lines.get(l.id)?.text.trim();
          return t ? [{ lang: o.lang, text: t }] : [];
        }),
      ],
    }));
}

/** 0:07, 12:34, 1:02:03. */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 00:01:02.345 */
function vttTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = String(Math.floor(t / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((t % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((t % 60_000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s}.${String(t % 1000).padStart(3, "0")}`;
}

/** WebVTT cue text: no "-->", and &, < escaped. */
const vttText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/-->/g, "→");

export function exportTranscript(format: TranscriptFormat, input: TranscriptInput): string {
  const all = rows(input);
  const many = input.languages.length > 1;
  const names = new Map(input.languages.map((l) => [l.lang, l.name] as const));
  const at = (ms: number) => input.talkMs(ms);
  switch (format) {
    case "txt": {
      const head = [input.title, input.languages.map((l) => l.name).join(" · "), ""];
      const body = all.flatMap((r) =>
        many
          ? [`[${clockOf(at(r.startMs))}]`, ...r.texts.map((t) => `  ${names.get(t.lang)}: ${t.text}`), ""]
          : [`[${clockOf(at(r.startMs))}] ${r.texts[0]!.text}`],
      );
      return [...head, ...body].join("\n").trimEnd() + "\n";
    }
    case "vtt": {
      const cues = all.map((r, i) => {
        const next = all[i + 1];
        const end = Math.min(r.endMs, next ? next.startMs : r.endMs);
        const text = many
          ? r.texts.map((t) => `<lang ${t.lang}>${vttText(t.text)}</lang>`).join("\n")
          : vttText(r.texts[0]!.text);
        return `${i + 1}\n${vttTime(at(r.startMs))} --> ${vttTime(at(Math.max(end, r.startMs + 1)))}\n${text}`;
      });
      return ["WEBVTT", "", ...cues.flatMap((c) => [c, ""])].join("\n");
    }
    case "md": {
      const head = [`# ${input.title}`, "", `Transcript · ${input.languages.map((l) => l.name).join(" · ")}`, ""];
      const body = all.flatMap((r) =>
        many
          ? [
              `**${clockOf(at(r.startMs))}** ${r.texts[0]!.text}`,
              ...r.texts.slice(1).map((t) => `> ${names.get(t.lang)}: ${t.text}`),
              "",
            ]
          : [`**${clockOf(at(r.startMs))}** ${r.texts[0]!.text}`, ""],
      );
      return [...head, ...body].join("\n").trimEnd() + "\n";
    }
  }
}

/** A safe file name: room-transcript-<lang|all>.<ext>. */
export function transcriptFileName(room: string, lang: string, format: TranscriptFormat): string {
  const safe = (s: string) => s.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "talk";
  return `${safe(room)}-transcript-${safe(lang)}.${format}`;
}

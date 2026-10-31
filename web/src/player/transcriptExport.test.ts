import { describe, expect, it } from "vitest";
import type { LineItem } from "../playback/wire";
import { exportTranscript, transcriptFileName } from "./transcriptExport";

const line = (id: string, startMs: number, text: string, final = true): LineItem => ({
  type: "line",
  id,
  startMs,
  endMs: startMs + 3_000,
  text,
  final,
});

const en = {
  lang: "en",
  name: "English (original)",
  lines: [line("b", 64_000, "Second line"), line("a", 1_000, "First line"), line("c", 70_000, "Not said yet", false)],
};
const es = { lang: "es", name: "Español", lines: [line("a", 1_000, "Primera línea"), line("b", 64_000, "Segunda")] };
const input = (languages = [en]) => ({ title: "Rivers", languages, talkMs: (ms: number) => ms - 1_000 });

describe("the transcript as a file", () => {
  it("keeps the final lines in time order with their talk time, in every format", () => {
    for (const format of ["txt", "md", "vtt"] as const) {
      const out = exportTranscript(format, input());
      expect(out.indexOf("First line")).toBeLessThan(out.indexOf("Second line"));
      expect(out).not.toContain("Not said yet");
    }
    const vtt = exportTranscript("vtt", input());
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    // Talk time: the first line starts the talk, the second 63 s in.
    expect(vtt).toContain("00:00:00.000 --> ");
    expect(vtt).toContain("00:01:03.000 --> ");
  });

  it("puts each language's text with the line it translates", () => {
    const md = exportTranscript("md", input([en, es]));
    expect(md.indexOf("Primera línea")).toBeGreaterThan(md.indexOf("First line"));
    expect(md.indexOf("Primera línea")).toBeLessThan(md.indexOf("Second line"));
    const vtt = exportTranscript("vtt", input([en, es]));
    expect(vtt).toContain("<lang es>Segunda</lang>");
  });

  it("escapes cue text so a line cannot break the subtitle file", () => {
    const vtt = exportTranscript("vtt", input([{ ...en, lines: [line("x", 1_000, "a --> b <i>")] }]));
    expect(vtt.split("-->")).toHaveLength(2);
    expect(vtt).not.toContain("<i>");
  });

  it("names the file after the room and language", () => {
    expect(transcriptFileName("physics-101", "all", "vtt")).toBe("physics-101-transcript-all.vtt");
    expect(transcriptFileName("../x", "es", "md")).toBe("x-transcript-es.md");
  });
});

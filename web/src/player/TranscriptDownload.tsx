import { useState } from "react";
import { SLICE_MS } from "../contracts/types";
import type { Playback } from "../playback/playback";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { languageOption } from "./languages";
import {
  exportTranscript,
  TRANSCRIPT_FORMATS,
  type TranscriptFormat,
  type TranscriptLanguage,
  transcriptFileName,
} from "./transcriptExport";

const ALL = "all";

/** Wait until these tracks are subscribed (the player turns them on after the next render), at most 3 s. */
async function subscribed(playback: Playback, ids: readonly string[]): Promise<void> {
  const ready = () =>
    ids.every((id) => playback.tracks.getSnapshot().tracks.find((t) => t.id === id)?.enabled === true);
  for (let i = 0; i < 30 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
}

/** Hand the browser a file to save. */
function save(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Download the transcript (the canvas's Panels board): as text, WebVTT subtitles or Markdown, in the original, a
 * translation, or every language the room offers. The whole talk so far is gathered from the tracks' history,
 * without moving the playhead. The lecture package (ticket 0023) joins these formats as a .zip once it is settled.
 */
export function TranscriptDownload() {
  const { tracks, prefs, playback, view, media, title, roomName, holdTracks } = usePlayer();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  const captions = tracks.captions;
  const translating = prefs.subtitleLang !== "original" && tracks.translations.some((t) => t.lang);
  const [pick, setPick] = useState<string>(() => (translating ? prefs.subtitleLang : "original"));
  if (!captions) return null;

  const name = (lang: string | undefined, original: boolean) => {
    const o = languageOption(lang ?? "en");
    return original ? `${o.autonym} (original)` : o.autonym;
  };
  const choices: [string, string][] = [
    ["original", name(captions.lang, true)],
    ...tracks.translations.map((t): [string, string] => [t.lang!, name(t.lang, false)]),
    ...(tracks.translations.length ? [[ALL, "All languages"] as [string, string]] : []),
  ];
  const chosen = choices.some(([v]) => v === pick) ? pick : "original";

  const download = async (format: TranscriptFormat) => {
    const t = view.timeline;
    const from = t.start;
    const to = Math.max(playback.liveEdge() ?? 0, t.available.at(-1)?.end ?? 0, t.liveEdge ?? 0) + 1;
    if (!(to > from)) return;
    const slices = Math.ceil((to - from) / SLICE_MS) + 2;
    const wanted = [
      ...(chosen === "original" || chosen === ALL ? [{ track: captions, original: true }] : []),
      ...tracks.translations
        .filter((tr) => chosen === ALL || tr.lang === chosen)
        .map((track) => ({ track, original: false })),
    ];
    setBusy(true);
    setSaid("Gathering the transcript…");
    // A language is gathered over its subscription (decision 0026): held while the download runs, then let go.
    const release = holdTracks(wanted.map((w) => w.track.id));
    try {
      await subscribed(
        playback,
        wanted.map((w) => w.track.id),
      );
      const languages: TranscriptLanguage[] = await Promise.all(
        wanted.map(async ({ track, original }) => ({
          lang: track.lang ?? "und",
          name: name(track.lang, original),
          lines: await playback.tracks.transcript(track.id, from, to, slices),
        })),
      );
      const text = exportTranscript(format, {
        title,
        languages,
        talkMs: (ms) => (media ? media.talkTime(ms) : ms - from),
      });
      const file = transcriptFileName(roomName, chosen === ALL ? "all" : (wanted[0]?.track.lang ?? chosen), format);
      save(file, text, TRANSCRIPT_FORMATS.find((f) => f.format === format)!.mime);
      setSaid(`Saved ${file}`);
    } catch {
      setSaid("Couldn't gather the transcript. Try again.");
    } finally {
      release();
      setBusy(false);
    }
  };

  return (
    <div className="tt-download" data-menu-root>
      <button
        type="button"
        className="tt-chip"
        aria-expanded={open}
        aria-controls="tt-download-popover"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="download" />
        Download
      </button>
      {open ? (
        <div className="tt-download-popover" id="tt-download-popover" role="group" aria-label="Download the transcript">
          <label className="tt-download-lang">
            <span>Language</span>
            <select className="tt-input" value={chosen} onChange={(e) => setPick(e.target.value)}>
              {choices.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="tt-download-formats">
            {TRANSCRIPT_FORMATS.map((f) => (
              <button
                key={f.format}
                type="button"
                className="tt-button"
                disabled={busy}
                onClick={() => void download(f.format)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {said ? (
            <p className="tt-muted tt-small" role="status">
              {said}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

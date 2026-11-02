import { useEffect, useRef, useState } from "react";
import "./download.css";
import type { PackageProgress } from "../package/build";
import { readIdentity } from "../annotate/client";
import {
  gatherDescriptions,
  gatherTranscripts,
  guardOf,
  languageName,
  outlineOf,
  saveFile,
  subscribed,
  talkSpan,
} from "../package/download";
import { gatherableTranslations, whyFree } from "../package/languages";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { exportTranscript, TRANSCRIPT_FORMATS, type TranscriptFormat, transcriptFileName } from "./transcriptExport";

const ALL = "all";

/**
 * The side panel's Download (the canvas's Panels board, ticket 0023): the transcript as text, WebVTT subtitles or
 * Markdown, in the original, a translation, or every language; and the lecture package, a .zip for an AI assistant
 * (wiki/spec/lecture-package.md). The whole talk so far is gathered from the tracks' history without moving the
 * playhead. "All languages" and the package take only translations already running or recorded for the room
 * (package/languages.ts): gathering any other would wake a paid agent.
 */
export function TranscriptDownload() {
  const ctx = usePlayer();
  const { tracks, prefs, playback, view, media, title, roomName, holdTracks, slides, notes, state } = ctx;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string>();
  const [progress, setProgress] = useState<PackageProgress>();
  const cancel = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => cancel.current?.abort(), []);
  const captions = tracks.captions;
  const translating = prefs.subtitleLang !== "original" && tracks.translations.some((t) => t.lang);
  const [pick, setPick] = useState<string>(() => (translating ? prefs.subtitleLang : "original"));

  const choices: [string, string][] = captions
    ? [
        ["original", languageName(captions.lang, true)],
        ...tracks.translations.map((t): [string, string] => [t.lang!, languageName(t.lang, false)]),
        ...(tracks.translations.length ? [[ALL, "All languages"] as [string, string]] : []),
      ]
    : [];
  const chosen = choices.some(([v]) => v === pick) ? pick : "original";
  const talkMs = (ms: number, from: number) => (media ? media.talkTime(ms) : ms - from);

  const download = async (format: TranscriptFormat) => {
    const span = talkSpan(view, playback);
    if (!span || !captions) return;
    const { included, left } = gatherableTranslations(tracks.translations, guardOf(ctx));
    const wanted = [
      ...(chosen === "original" || chosen === ALL ? [{ track: captions, original: true }] : []),
      ...(chosen === ALL ? included : tracks.translations.filter((tr) => tr.lang === chosen)).map((track) => ({
        track,
        original: false,
      })),
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
      const languages = await gatherTranscripts(playback, wanted, span);
      const text = exportTranscript(format, { title, languages, talkMs: (ms) => talkMs(ms, span.from) });
      const file = transcriptFileName(roomName, chosen === ALL ? "all" : (wanted[0]?.track.lang ?? chosen), format);
      const mime = TRANSCRIPT_FORMATS.find((f) => f.format === format)!.mime;
      saveFile(file, new Blob([text], { type: `${mime};charset=utf-8` }));
      const skipped = chosen === ALL && left.length ? ` (${left.length} not running left out)` : "";
      setSaid(`Saved ${file}${skipped}`);
    } catch {
      setSaid("Couldn't gather the transcript. Try again.");
    } finally {
      release();
      setBusy(false);
    }
  };

  const downloadPackage = async () => {
    const span = talkSpan(view, playback);
    if (!span) return;
    const controller = new AbortController();
    cancel.current = controller;
    const { included, left } = gatherableTranslations(tracks.translations, guardOf(ctx));
    const wanted = [
      ...(captions ? [{ track: captions, original: true }] : []),
      ...included.map((track) => ({ track, original: false })),
    ];
    const outline = tracks.outline;
    // Slide descriptions only when the describe agent is already running or recorded: any other read wakes it.
    const describe = tracks.describe && whyFree(tracks.describe, guardOf(ctx)) ? tracks.describe : undefined;
    // The listener's own annotations are theirs by the id the room service gave this browser (kept across reloads).
    const mine = ctx.listening?.service.me()?.id ?? readIdentity().id;
    const ids = [
      ...wanted.map((w) => w.track.id),
      ...(outline ? [outline.id] : []),
      ...(describe ? [describe.id] : []),
    ];
    setBusy(true);
    setSaid(undefined);
    setProgress({ label: "Gathering the transcript…", fraction: 0 });
    const release = holdTracks(ids);
    try {
      const [{ buildLecturePackage }] = await Promise.all([import("../package/build"), subscribed(playback, ids)]);
      controller.signal.throwIfAborted();
      const [languages, gotOutline, descriptions] = await Promise.all([
        gatherTranscripts(playback, wanted, span),
        outline ? outlineOf(playback, outline.id) : undefined,
        describe ? gatherDescriptions(playback, describe, span) : undefined,
      ]);
      controller.signal.throwIfAborted();
      const built = await buildLecturePackage({
        source: slides?.source,
        room: roomName,
        title,
        speaker: ctx.slides?.roomInfo().speaker,
        live: state.kind !== "ended",
        fromMs: span.from,
        toMs: span.to,
        talkMs: (ms) => talkMs(ms, span.from),
        languages,
        outline: gotOutline,
        notes: notes.notes,
        mine,
        descriptions,
        leftOut: left.map((t) => languageName(t.lang, false)),
        signal: controller.signal,
        onProgress: setProgress,
      });
      saveFile(built.fileName, built.blob);
      setSaid(`Saved ${built.fileName}`);
    } catch (err) {
      setSaid(controller.signal.aborted ? "Cancelled." : "Couldn't build the lecture package. Try again.");
      if (!controller.signal.aborted) console.warn("lecture package", err);
    } finally {
      release();
      cancel.current = undefined;
      setProgress(undefined);
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
          {captions ? (
            <>
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
            </>
          ) : null}
          <div className="tt-download-formats tt-download-package">
            <button type="button" className="tt-button" disabled={busy} onClick={() => void downloadPackage()}>
              Lecture package (.zip)
            </button>
            <p className="tt-muted tt-small">
              Transcripts, chapters, slides with ink, your notes and your own marks, for an AI assistant.
            </p>
          </div>
          {progress ? (
            <div className="tt-download-progress">
              <progress max={1} value={progress.fraction} aria-label="Building the lecture package" />
              <p className="tt-muted tt-small" role="status">
                {progress.label}
              </p>
              <button type="button" className="tt-link" onClick={() => cancel.current?.abort()}>
                Cancel
              </button>
            </div>
          ) : said ? (
            <p className="tt-muted tt-small" role="status">
              {said}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

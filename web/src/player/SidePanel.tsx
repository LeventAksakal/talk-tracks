import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { LineItem } from "../playback/wire";
import { MoqTransport } from "../transport/moq";
import { dirOf } from "../viewer/lang";
import { ChatTab } from "./Chat";
import { usePlayer } from "./context";
import { Icon, type IconName } from "./icons";
import { fold, languageOption } from "./languages";
import { notesMarkdown } from "./notes";
import type { TrackView } from "../playback/aiTracks";
import type { PanelTab } from "./prefs";
import { chapterAt } from "./timeline";
import { transcriptLines, translationFor } from "./tracks";
import { TranscriptDownload } from "./TranscriptDownload";

// The side panel's jobs (decision 0033): each answers one thing the viewer is doing. Talking with the room (Chat),
// following what is said (Transcript), finding a place in the talk (Chapters, with its terms and the slides as text),
// keeping their own notes (Notes); Discussion joins them only where listeners can comment. Chat goes first when there
// is a relay to read it from and a room to talk with (not a recording). A panel is a subscription (decision 0026):
// its track is subscribed while it is open.
const CHAT: [PanelTab, string] = ["chat", "Chat"];
const JOBS: [PanelTab, string][] = [
  ["transcript", "Transcript"],
  ["chapters", "Chapters"],
  ["notes", "Notes"],
];
/** The Chapters job's views: one track (the outline) for chapters and terms, the descriptions for the slides. */
const FIND: [PanelTab, string][] = [
  ["chapters", "Chapters"],
  ["glossary", "Terms"],
  ["descriptions", "Slides"],
];
const ICON: Record<string, IconName> = { chat: "chat", transcript: "transcript", chapters: "chapters", notes: "notes" };

/** The job a tab belongs to: the Chapters job holds its terms and slides. */
const jobOf = (tab: PanelTab): PanelTab => (tab === "glossary" || tab === "descriptions" ? "chapters" : tab);

/**
 * The side panel (ui-design §4.6), beside the player, never over it: one job at a time, picked from the tabs or by
 * what the viewer does (/ searches the transcript, N writes a note, the chapter name opens Chapters).
 */
export function SidePanel() {
  const { prefs, update, extraTabs, transport, vod } = usePlayer();
  // A recording has nobody in the room to chat with.
  const chat = transport instanceof MoqTransport && !vod;
  const tabs: [PanelTab, string][] = [
    ...(chat ? [CHAT] : []),
    ...JOBS,
    ...extraTabs.map((t): [PanelTab, string] => [t.id, t.label]),
  ];
  const job = tabs.some(([id]) => id === jobOf(prefs.tab)) ? jobOf(prefs.tab) : "transcript";
  const current = job === "chapters" ? prefs.tab : job;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex(([id]) => id === job);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : undefined;
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const [id] = tabs[(next + tabs.length) % tabs.length]!;
    update({ tab: id });
    document.getElementById(`tt-tab-${id}`)?.focus();
  };
  const extra = extraTabs.find((t) => t.id === job);
  return (
    <aside className="tt-panel" aria-label="Side panel">
      <div className="tt-panel-head">
        <div className="tt-tabs" role="tablist" aria-label="Side panel" onKeyDown={onKey}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              id={`tt-tab-${id}`}
              type="button"
              role="tab"
              className="tt-tab"
              aria-selected={job === id}
              aria-controls={`tt-tabpanel-${id}`}
              tabIndex={job === id ? 0 : -1}
              onClick={() => update({ tab: id })}
            >
              <Icon name={ICON[id] ?? "comment"} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tt-icon-button tt-small tt-panel-close"
          aria-label="Close the side panel"
          onClick={() => update({ panel: false })}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="tt-tabpanel" role="tabpanel" id={`tt-tabpanel-${job}`} aria-labelledby={`tt-tab-${job}`}>
        {job === "chapters" ? (
          <div className="tt-views" role="group" aria-label="Show">
            {FIND.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="tt-view"
                aria-pressed={current === id}
                onClick={() => update({ tab: id })}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {current === "chat" ? <ChatTab /> : null}
        {current === "transcript" ? <Transcript /> : null}
        {current === "chapters" ? <Chapters /> : null}
        {current === "glossary" ? <Glossary /> : null}
        {current === "descriptions" ? <Descriptions /> : null}
        {current === "notes" ? <Notes /> : null}
        {extra ? extra.content : null}
      </div>
    </aside>
  );
}

/**
 * Where a tab's track stands (decision 0026: a panel is a subscription): subscribing, loading what came before the
 * playhead, or starting from now and filling as the talk goes. Nothing once it has something to show: lines already
 * shown are what there is so far, and a slice still on its way only adds to them.
 */
function TrackStatus({ track, what, empty }: { track: TrackView; what: string; empty: boolean }) {
  const { view } = usePlayer();
  const live = view.timeline.mode === "live";
  const text = !track.enabled
    ? `Subscribing to the ${what}…`
    : track.sliced?.capped
      ? `The ${what} is unavailable right now.`
      : empty && (track.loading || (track.sliced && !track.sliced.loaded))
        ? `Loading the ${what} so far…`
        : empty && live
          ? `Starting from now: the ${what} fills in as the talk goes.`
          : empty
            ? `Nothing in the ${what} up to here.`
            : undefined;
  return text ? (
    <p className="tt-muted tt-track-status" role="status">
      {text}
    </p>
  ) : null;
}

function Seek({ ms, children }: { ms: number; children?: ReactNode }) {
  const { seek, talkClock } = usePlayer();
  return (
    <button type="button" className="tt-time-link" onClick={() => seek(ms)} aria-label={`Play from ${talkClock(ms)}`}>
      {children ?? talkClock(ms)}
    </button>
  );
}

// --- transcript ------------------------------------------------------------------------------------

function Transcript() {
  const { tracks, prefs, ui, setUi, at } = usePlayer();
  const captions = tracks.captions;
  const search = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const translation =
    prefs.cc && prefs.subtitleLang !== "original" ? translationFor(tracks, prefs.subtitleLang) : undefined;
  // A recording's transcript is the whole lecture from 0:00 (read from the archive); a live room's, what is held.
  const whole = captions?.enabled === true && captions.transcript !== undefined;
  const lines = transcriptLines(captions);
  const translated = new Map(transcriptLines(translation).map((l) => [l.id, l] as const));
  const query = fold(ui.search.trim());
  const shown = query.length >= 2 ? lines.filter((l) => fold(l.text).includes(query)) : lines;
  const last = shown.at(-1);
  // The line at the playhead, which the whole lecture's transcript follows instead of the newest line.
  const current = whole ? lines.findLast((l) => at === undefined || l.startMs <= at)?.id : undefined;

  useEffect(() => {
    if (ui.focusSearch) search.current?.focus();
  }, [ui.focusSearch]);

  // Follow the newest line (live) or the line at the playhead (a recording) until the viewer scrolls away; the
  // jump button brings it back.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !following) return;
    if (!whole) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const line = el.querySelector<HTMLElement>("[data-current]");
    if (!line) return;
    const box = el.getBoundingClientRect();
    const r = line.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) el.scrollTop += r.top - box.top - el.clientHeight / 3;
  }, [following, whole, current, last?.id, last?.text, shown.length]);

  if (!captions) return <p className="tt-empty">This room has no transcript yet.</p>;

  const transLang = translation?.lang ?? prefs.subtitleLang;
  return (
    <div className="tt-transcript">
      <TrackStatus track={captions} what="transcript" empty={lines.length === 0} />
      <div className="tt-transcript-tools">
        <input
          ref={search}
          className="tt-input"
          type="search"
          placeholder="Search the transcript (/)"
          aria-label="Search the transcript"
          value={ui.search}
          onChange={(e) => setUi({ search: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") setUi({ search: "" });
            e.stopPropagation();
          }}
        />
        <TranscriptDownload />
      </div>
      {query.length >= 2 ? (
        <p className="tt-muted" role="status">
          {shown.length} line{shown.length === 1 ? "" : "s"} match, marked on the progress bar.
        </p>
      ) : null}
      <div
        ref={body}
        className={`tt-transcript-body${translation ? " tt-dual" : ""}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!whole) return setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          // Following while the line at the playhead is in view (no line yet, before the first word: following).
          const line = el.querySelector<HTMLElement>("[data-current]");
          if (!line) return;
          const box = el.getBoundingClientRect();
          const r = line.getBoundingClientRect();
          setFollowing(r.bottom > box.top && r.top < box.bottom);
        }}
      >
        {shown.length === 0 && query ? <p className="tt-muted">No line matches.</p> : null}
        {shown.map((l) => (
          <TranscriptLine
            key={l.id}
            line={l}
            lang={captions.lang ?? "en"}
            translation={translated.get(l.id)}
            transLang={transLang}
            current={l.id === current}
            ahead={whole && at !== undefined && l.startMs > at}
          />
        ))}
      </div>
      {!following ? (
        <button type="button" className="tt-jump" onClick={() => setFollowing(true)}>
          {whole ? "Jump to now" : "Jump to latest"}
        </button>
      ) : null}
      {translation ? (
        <p className="tt-muted tt-small-print">With {languageOption(transLang).local} beside each line.</p>
      ) : null}
    </div>
  );
}

function TranscriptLine({
  line,
  lang,
  translation,
  transLang,
  current = false,
  ahead = false,
}: {
  line: LineItem;
  lang: string;
  translation: LineItem | undefined;
  transLang: string;
  /** The line at the playhead. */
  current?: boolean;
  /** Still to come in a recording. */
  ahead?: boolean;
}) {
  return (
    <div
      className={`tt-line${line.final ? "" : " tt-line-interim"}${current ? " tt-line-current" : ""}${ahead ? " tt-line-ahead" : ""}`}
      data-current={current ? "" : undefined}
      aria-current={current ? "true" : undefined}
    >
      <Seek ms={line.startMs} />
      <span lang={lang} dir={dirOf(lang)}>
        {line.text}
      </span>
      {translation ? (
        <span lang={transLang} dir={dirOf(transLang)} className="tt-line-translation">
          {translation.text}
        </span>
      ) : null}
    </div>
  );
}

// --- chapters --------------------------------------------------------------------------------------

function Chapters() {
  const { tracks, at, view } = usePlayer();
  const recapId = useId();
  const outline = tracks.outline;
  if (!outline) return <p className="tt-empty">This room has no chapters yet.</p>;
  const o = outline.enabled ? outline.outline : undefined;
  if (!o || o.chapters.length === 0) return <TrackStatus track={outline} what="chapters" empty />;
  const current = chapterAt(o.chapters, at);
  const lang = outline.lang ?? "en";
  const live = view.timeline.mode === "live";
  return (
    <div className="tt-chapters" lang={lang} dir={dirOf(lang)}>
      {o.recap ? (
        <section className="tt-recap" aria-labelledby={recapId}>
          <strong id={recapId}>So far</strong>
          <p>{o.recap}</p>
        </section>
      ) : null}
      <ol className="tt-chapter-list">
        {o.chapters.map((c, i) => (
          <li
            key={c.id}
            className={current?.id === c.id ? "tt-current" : undefined}
            aria-current={current?.id === c.id}
          >
            <Seek ms={c.start_ms} />
            <div>
              <strong>{c.title}</strong>
              {live && i === o.chapters.length - 1 ? <span className="tt-live-tag"> · live</span> : null}
              <p>{c.summary}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// --- glossary --------------------------------------------------------------------------------------

function Glossary() {
  const { tracks } = usePlayer();
  const outline = tracks.outline;
  if (!outline) return <p className="tt-empty">This room has no glossary yet.</p>;
  const terms = outline.enabled
    ? [...(outline.outline?.glossary ?? [])].sort((a, b) => a.term.localeCompare(b.term))
    : [];
  if (terms.length === 0) return <TrackStatus track={outline} what="glossary" empty />;
  const lang = outline.lang ?? "en";
  return (
    <dl className="tt-glossary" lang={lang} dir={dirOf(lang)}>
      {terms.map((g) => (
        <div key={g.term}>
          <dt>{g.term}</dt>
          <dd>{g.definition}</dd>
        </div>
      ))}
    </dl>
  );
}

// --- slide descriptions ----------------------------------------------------------------------------

/** Each slide's description up to the playhead, the one on screen first: the slides as text. */
function Descriptions() {
  const { tracks } = usePlayer();
  const describe = tracks.describe;
  if (!describe) return <p className="tt-empty">This room has no slide descriptions yet.</p>;
  const slides = describe.enabled ? (describe.sliced?.slides ?? []) : [];
  const current = describe.enabled ? describe.sliced?.slide : undefined;
  const lang = describe.lang ?? "en";
  if (slides.length === 0) return <TrackStatus track={describe} what="slide descriptions" empty />;
  return (
    <ol className="tt-chapter-list tt-descriptions" lang={lang} dir={dirOf(lang)} aria-label="Slide descriptions">
      {[...slides].reverse().map((s) => (
        <li key={`${s.id}:${s.atMs}`} aria-current={current?.id === s.id && current.atMs === s.atMs}>
          <Seek ms={s.atMs} />
          <div>
            <strong>Slide {s.id + 1}</strong>
            <p>{s.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// --- notes -----------------------------------------------------------------------------------------

function Notes() {
  const { notes, at, talkClock, ui, title, addBookmark, slideNumber } = usePlayer();
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ui.focusNote) box.current?.focus();
  }, [ui.focusNote]);
  const save = () => {
    if (!text.trim() || at === undefined) return;
    notes.add({ at, text: text.trim(), slide: slideNumber });
    setText("");
  };
  const exportMarkdown = () => {
    const blob = new Blob([notesMarkdown(title, notes.notes, talkClock)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "notes"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <div className="tt-notes">
      <label className="tt-menu-heading" htmlFor="tt-note">
        Note at {at === undefined ? "–" : talkClock(at)}
      </label>
      <textarea
        id="tt-note"
        ref={box}
        className="tt-input"
        rows={2}
        value={text}
        placeholder="Type a note (N)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="tt-row">
        <button type="button" className="tt-button" onClick={save} disabled={!text.trim()}>
          Save note
        </button>
        <button type="button" className="tt-button tt-secondary" onClick={addBookmark}>
          Bookmark (B)
        </button>
      </div>
      {notes.notes.length === 0 ? (
        <p className="tt-muted">Bookmarks and notes stay in this browser.</p>
      ) : (
        <ul className="tt-note-list" aria-label="Notes">
          {notes.notes.map((n) => (
            <li key={n.id}>
              <Seek ms={n.at} />
              <span>
                {n.text || "★ Bookmark"}
                {n.slide ? <span className="tt-muted"> · slide {n.slide}</span> : null}
              </span>
              <button
                type="button"
                className="tt-icon-button tt-small"
                aria-label={`Delete note at ${talkClock(n.at)}`}
                onClick={() => notes.remove(n.id)}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {notes.notes.length > 0 ? (
        <button type="button" className="tt-button tt-secondary" onClick={exportMarkdown}>
          Export as Markdown
        </button>
      ) : null}
    </div>
  );
}

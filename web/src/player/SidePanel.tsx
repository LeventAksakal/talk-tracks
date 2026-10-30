import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatClock } from "../playback/timeline";
import type { LineItem } from "../playback/wire";
import { dirOf } from "../viewer/lang";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { fold, languageOption } from "./languages";
import { notesMarkdown } from "./notes";
import type { PanelTab } from "./prefs";
import { chapterAt } from "./timeline";
import { translationFor } from "./tracks";

const TABS: [PanelTab, string][] = [
  ["transcript", "Transcript"],
  ["chapters", "Chapters"],
  ["glossary", "Glossary"],
  ["notes", "Notes"],
];

/**
 * The side panel (ui-design §4.6), beside the player, never over it: Transcript, Chapters (So far on top),
 * Glossary and Notes, plus any extra tab a later lane adds (Discussion).
 */
export function SidePanel() {
  const { prefs, update, extraTabs } = usePlayer();
  const tabs: [PanelTab, string][] = [...TABS, ...extraTabs.map((t): [PanelTab, string] => [t.id, t.label])];
  const current = tabs.some(([id]) => id === prefs.tab) ? prefs.tab : "transcript";
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex(([id]) => id === current);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : undefined;
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const [id] = tabs[(next + tabs.length) % tabs.length]!;
    update({ tab: id });
    document.getElementById(`tt-tab-${id}`)?.focus();
  };
  const extra = extraTabs.find((t) => t.id === current);
  return (
    <aside className="tt-panel" aria-label="Side panel">
      <div className="tt-tabs" role="tablist" aria-label="Side panel" onKeyDown={onKey}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            id={`tt-tab-${id}`}
            type="button"
            role="tab"
            className="tt-tab"
            aria-selected={current === id}
            aria-controls={`tt-tabpanel-${id}`}
            tabIndex={current === id ? 0 : -1}
            onClick={() => update({ tab: id })}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="tt-icon-button tt-small tt-panel-close"
          aria-label="Close the side panel"
          onClick={() => update({ panel: false })}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="tt-tabpanel" role="tabpanel" id={`tt-tabpanel-${current}`} aria-labelledby={`tt-tab-${current}`}>
        {current === "transcript" ? <Transcript /> : null}
        {current === "chapters" ? <Chapters /> : null}
        {current === "glossary" ? <Glossary /> : null}
        {current === "notes" ? <Notes /> : null}
        {extra ? extra.content : null}
      </div>
    </aside>
  );
}

function TurnOn({ text, label, onClick }: { text: string; label: string; onClick: () => void }) {
  return (
    <div className="tt-empty">
      <p>{text}</p>
      <button type="button" className="tt-button" onClick={onClick}>
        {label}
      </button>
    </div>
  );
}

function Seek({ ms, children }: { ms: number; children?: ReactNode }) {
  const { seek } = usePlayer();
  return (
    <button type="button" className="tt-time-link" onClick={() => seek(ms)} aria-label={`Play from ${formatClock(ms)}`}>
      {children ?? formatClock(ms)}
    </button>
  );
}

// --- transcript ------------------------------------------------------------------------------------

function Transcript() {
  const { tracks, prefs, update, ui, setUi } = usePlayer();
  const captions = tracks.captions;
  const search = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const translation =
    prefs.cc && prefs.subtitleLang !== "original" ? translationFor(tracks, prefs.subtitleLang) : undefined;
  const lines = captions?.enabled ? (captions.sliced?.lines ?? []) : [];
  const translated = new Map(
    (translation?.enabled ? (translation.sliced?.lines ?? []) : []).map((l) => [l.id, l] as const),
  );
  const query = fold(ui.search.trim());
  const shown = query.length >= 2 ? lines.filter((l) => fold(l.text).includes(query)) : lines;
  const last = shown.at(-1);

  useEffect(() => {
    if (ui.focusSearch) search.current?.focus();
  }, [ui.focusSearch]);

  // Follow the newest line until the viewer scrolls up; "Jump to latest" brings it back.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [following, last?.id, last?.text, shown.length]);

  if (!captions) return <p className="tt-empty">This room has no transcript yet.</p>;
  if (!captions.enabled)
    return (
      <TurnOn
        text="The transcript is the captions track, line by line."
        label="Show the transcript"
        onClick={() => update({ transcript: true })}
      />
    );

  const transLang = translation?.lang ?? prefs.subtitleLang;
  return (
    <div className="tt-transcript">
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
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {shown.length === 0 ? (
          <p className="tt-muted">{query ? "No line matches." : "Lines appear here as the speaker talks."}</p>
        ) : null}
        {shown.map((l) => (
          <TranscriptLine
            key={l.id}
            line={l}
            lang={captions.lang ?? "en"}
            translation={translated.get(l.id)}
            transLang={transLang}
          />
        ))}
      </div>
      {!following ? (
        <button type="button" className="tt-jump" onClick={() => setFollowing(true)}>
          Jump to latest
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
}: {
  line: LineItem;
  lang: string;
  translation: LineItem | undefined;
  transLang: string;
}) {
  return (
    <div className={`tt-line${line.final ? "" : " tt-line-interim"}`}>
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
  const { tracks, prefs, update, at, view } = usePlayer();
  const outline = tracks.outline;
  if (!outline) return <p className="tt-empty">This room has no chapters yet.</p>;
  if (!prefs.chapters || !outline.enabled)
    return (
      <TurnOn
        text="Chapters, a recap so far and a glossary, written as the talk goes."
        label="Turn on chapters"
        onClick={() => update({ chapters: true })}
      />
    );
  const o = outline.outline;
  if (!o) return <p className="tt-muted">Waiting for the first chapter…</p>;
  const current = chapterAt(o.chapters, at);
  const lang = outline.lang ?? "en";
  const live = view.timeline.mode === "live";
  return (
    <div className="tt-chapters" lang={lang} dir={dirOf(lang)}>
      {o.recap ? (
        <section className="tt-recap" aria-label="So far">
          <strong>So far</strong>
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
  const { tracks, prefs, update } = usePlayer();
  const outline = tracks.outline;
  if (!outline) return <p className="tt-empty">This room has no glossary yet.</p>;
  if (!prefs.chapters || !outline.enabled)
    return (
      <TurnOn
        text="Terms from the talk with their definitions, A to Z."
        label="Turn on chapters and glossary"
        onClick={() => update({ chapters: true })}
      />
    );
  const terms = [...(outline.outline?.glossary ?? [])].sort((a, b) => a.term.localeCompare(b.term));
  if (terms.length === 0) return <p className="tt-muted">No terms yet.</p>;
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

// --- notes -----------------------------------------------------------------------------------------

function Notes() {
  const { notes, at, ui, title, addBookmark, tracks } = usePlayer();
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ui.focusNote) box.current?.focus();
  }, [ui.focusNote]);
  const slide = tracks.describe?.enabled ? tracks.describe.sliced?.slide : undefined;
  const save = () => {
    if (!text.trim() || at === undefined) return;
    notes.add({ at, text: text.trim(), slide: slide ? slide.id + 1 : undefined });
    setText("");
  };
  const exportMarkdown = () => {
    const blob = new Blob([notesMarkdown(title, notes.notes)], { type: "text/markdown" });
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
        Note at {at === undefined ? "–" : formatClock(at)}
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
                aria-label={`Delete note at ${formatClock(n.at)}`}
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

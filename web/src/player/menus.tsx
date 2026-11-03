// The control bar's menus (ui-design §3.1, §4.1–§4.2, §4.7): subtitles with the language search and the
// style submenu, layout, settings. Each is a small dialog of ordinary buttons and inputs, so Tab reaches
// everything; the subtitle style previews live on the canvas while its menu is open.

import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { guardOf } from "../package/download";
import { MoqHistorySource } from "../playback/moqSource";
import { MoqTransport } from "../transport/moq";
import type { Transport } from "../transport/types";
import { usePlayer } from "./context";
import { languageOption, searchLanguages, SUPPORTED_LANGUAGES } from "./languages";
import { type BoardKind, type LayoutKind } from "./prefs";
import { StatsFeed } from "./roomStats";
import { effectiveLayout, stageSources } from "./Stage";
import { type LanguageReadiness, languageReadiness, translationFor } from "./tracks";

/** What the subtitles menu says under a language, by how ready it is ("in this room" only for ready ones). */
const READINESS_NOTE: Record<LanguageReadiness, string | undefined> = {
  running: "running in this room",
  recorded: "recorded in this room",
  // Said once, under the search field, rather than on every language row.
  "on-request": undefined,
  absent: undefined,
};
const READY_FIRST: Record<LanguageReadiness, number> = { running: 0, recorded: 0, "on-request": 1, absent: 2 };

/**
 * The tracks the room's stats track lists as running (decision 0028), read while the subtitles menu is open; undefined
 * without a relay or before the first snapshot.
 */
function useStatsRunning(transport: Transport | undefined, room: string): ReadonlySet<string> | undefined {
  const feed = useMemo(
    () => (transport instanceof MoqTransport ? new StatsFeed(new MoqHistorySource(transport), room) : undefined),
    [transport, room],
  );
  useEffect(() => {
    feed?.start();
    return () => feed?.stop();
  }, [feed]);
  useSyncExternalStore(feed?.subscribe ?? (() => () => {}), feed?.getVersion ?? (() => 0));
  const stats = feed?.view().stats;
  return useMemo(
    () =>
      stats
        ? new Set(stats.tracks.filter((t) => t.state === "running").map((t) => `${t.namespace}/${t.name}`))
        : undefined,
    [stats],
  );
}

function Menu({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus moves into the menu when it opens, onto its first control, and back to where it was (the menu's
    // button) when it closes, unless the viewer has moved it elsewhere since.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = ref.current;
    menu?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (before?.isConnected && (!now || now === document.body || menu?.contains(now)))
        before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div ref={ref} className={`tt-menu${wide ? " tt-menu-wide" : ""}`} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

function Choice({
  checked,
  onClick,
  children,
  sub,
}: {
  checked: boolean;
  onClick: () => void;
  children: ReactNode;
  sub?: string;
}) {
  return (
    <button type="button" className="tt-menu-item" aria-pressed={checked} onClick={onClick}>
      <span>{children}</span>
      {sub ? <span className="tt-menu-sub">{sub}</span> : null}
    </button>
  );
}

export function CaptionsMenu() {
  const ctx = usePlayer();
  const { prefs, update, tracks } = ctx;
  const [query, setQuery] = useState("");
  const original = tracks.captions;
  const originalName = languageOption(original?.lang ?? "en").local;
  const statsRunning = useStatsRunning(ctx.transport, ctx.roomName);
  const guard = guardOf(ctx);
  const readiness = (tag: string) => languageReadiness(translationFor(tracks, tag), guard, statsRunning);
  const inRoom = tracks.translations.map((t) => t.lang!).filter(Boolean);
  // Every language, by its name in the viewer's language (the name each row leads with), so the list reads A to Z.
  const all = useMemo(
    () => SUPPORTED_LANGUAGES.map((tag) => languageOption(tag)).sort((a, b) => a.local.localeCompare(b.local)),
    [],
  );
  // The room's languages first, the ready ones at the top; then every other language.
  const roomOptions = inRoom
    .map((tag) => ({ option: languageOption(tag), order: READY_FIRST[readiness(tag)] }))
    .sort((a, b) => a.order - b.order)
    .map((o) => o.option);
  const others = all.filter((o) => !inRoom.some((tag) => tag.split("-")[0] === o.tag));
  const results = searchLanguages([...roomOptions, ...others], query);
  const translating = prefs.subtitleLang !== "original";
  const pick = (lang: string) => update({ cc: true, subtitleLang: lang });

  return (
    <Menu label="Subtitles" wide>
      <Choice checked={!prefs.cc} onClick={() => update({ cc: false })}>
        Off
      </Choice>
      <Choice
        checked={prefs.cc && !translating}
        onClick={() => pick("original")}
        sub={original ? undefined : "not in this room yet"}
      >
        Original ({originalName})
      </Choice>
      <label className="tt-menu-heading" htmlFor="tt-lang-search">
        Translate to…
      </label>
      <input
        id="tt-lang-search"
        className="tt-input"
        type="search"
        placeholder="Search any language"
        value={query}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="tt-menu-note">{all.length} languages. One not yet running starts a moment after you pick it.</p>
      <div className="tt-menu-list" role="group" aria-label="Languages">
        {results.map((o) => {
          return (
            <Choice
              key={o.tag}
              checked={prefs.cc && prefs.subtitleLang === o.tag}
              onClick={() => pick(o.tag)}
              sub={READINESS_NOTE[readiness(o.tag)]}
            >
              {o.local}
              {o.local !== o.autonym ? (
                <span className="tt-menu-local">
                  {" · "}
                  <span lang={o.tag} dir={o.dir}>
                    {o.autonym}
                  </span>
                </span>
              ) : null}
            </Choice>
          );
        })}
        {results.length === 0 ? <p className="tt-menu-note">No language matches “{query}”.</p> : null}
      </div>
      {translating ? (
        <Choice checked={prefs.dual} onClick={() => update({ dual: !prefs.dual })}>
          Dual subtitles: original above the translation
        </Choice>
      ) : null}
      {prefs.subtitlePos ? (
        <button type="button" className="tt-menu-item" onClick={() => update({ subtitlePos: undefined })}>
          Put the subtitles back in place
        </button>
      ) : null}
      <span className="tt-menu-heading">Sound</span>
      <Choice checked={prefs.sound === "speaker"} onClick={() => update({ sound: "speaker" })}>
        Speaker
      </Choice>
      <Choice
        checked={prefs.sound === "describe"}
        onClick={() => {
          unlockSpeech();
          update({ sound: "describe" });
        }}
        sub={tracks.describe ? undefined : "not in this room yet"}
      >
        Slides read aloud too
      </Choice>
    </Menu>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The stage's layout. The labels name the pictures there are: the slides, a shared screen, the camera. While a screen
 * is shared the slides stay on offer, and the listener picks which of the two is the main picture.
 */
export function LayoutMenu() {
  const { prefs, update, sources, setUi } = usePlayer();
  const placed = stageSources(sources, prefs.board);
  const layout = effectiveLayout(prefs.layout, placed);
  const main = placed.at(-1) ?? "slides";
  const corner = placed.length > 1 ? placed[0]! : "camera";
  const boards = (["screen", "slides"] as const).filter((k) => sources.includes(k));
  const close = () => setUi({ menu: undefined });
  const layouts: [LayoutKind, string][] = [
    ["pip", `${capital(main)}, ${corner} in a corner`],
    ["split", "Side by side"],
    ["single", "One at a time"],
  ];
  const pickBoard = (board: BoardKind) => update({ board, single: board });
  return (
    <Menu label="Layout">
      {layouts.map(([value, label]) => (
        <Choice
          key={value}
          checked={layout === value}
          onClick={() => {
            update({ layout: value });
            close();
          }}
        >
          {label}
        </Choice>
      ))}
      {layout === "single" ? (
        <>
          <span className="tt-menu-heading">Show</span>
          {boards.map((k) => (
            <Choice key={k} checked={prefs.single !== "camera" && main === k} onClick={() => pickBoard(k)}>
              {capital(k)}
            </Choice>
          ))}
          {sources.includes("camera") ? (
            <Choice checked={prefs.single === "camera"} onClick={() => update({ single: "camera" })}>
              Camera
            </Choice>
          ) : null}
        </>
      ) : (
        <>
          {boards.length > 1 ? (
            <>
              <span className="tt-menu-heading">Main picture</span>
              {boards.map((k) => (
                <Choice key={k} checked={main === k} onClick={() => pickBoard(k)}>
                  {capital(k)}
                </Choice>
              ))}
            </>
          ) : null}
          <button type="button" className="tt-menu-item" onClick={() => update({ swap: !prefs.swap })}>
            Swap {corner} and {main}
          </button>
        </>
      )}
    </Menu>
  );
}

/** Some browsers speak later utterances only after one started inside a gesture. */
function unlockSpeech(): void {
  try {
    if (typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined")
      speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  } catch {
    // No speech here: the text stays.
  }
}

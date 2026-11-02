// The control bar's menus (ui-design §3.1, §4.1–§4.2, §4.7): subtitles with the language search and the
// style submenu, layout, settings. Each is a small dialog of ordinary buttons and inputs, so Tab reaches
// everything; the subtitle style previews live on the canvas while its menu is open.

import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { guardOf } from "../package/download";
import { MoqHistorySource } from "../playback/moqSource";
import { MoqTransport } from "../transport/moq";
import type { Transport } from "../transport/types";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { languageOption, searchLanguages, SUPPORTED_LANGUAGES } from "./languages";
import { type BoardKind, DEFAULT_STYLE, type LayoutKind, type SubtitlePreset, SUBTITLE_PRESETS } from "./prefs";
import { StatsFeed } from "./roomStats";
import { effectiveLayout, stageSources } from "./Stage";
import { type LanguageReadiness, languageReadiness, translationFor } from "./tracks";

/** What the subtitles menu says under a language, by how ready it is ("in this room" only for ready ones). */
const READINESS_NOTE: Record<LanguageReadiness, string | undefined> = {
  running: "running in this room",
  recorded: "recorded in this room",
  "on-request": "starts when picked · takes a moment",
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
  const { prefs, update, tracks, setUi } = ctx;
  const [query, setQuery] = useState("");
  const original = tracks.captions;
  const originalName = languageOption(original?.lang ?? "en").local;
  const statsRunning = useStatsRunning(ctx.transport, ctx.roomName);
  const guard = guardOf(ctx);
  const readiness = (tag: string) => languageReadiness(translationFor(tracks, tag), guard, statsRunning);
  const inRoom = tracks.translations.map((t) => t.lang!).filter(Boolean);
  const all = useMemo(() => SUPPORTED_LANGUAGES.map((tag) => languageOption(tag)), []);
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
      <div className="tt-menu-list" role="group" aria-label="Languages">
        {results.map((o) => {
          return (
            <Choice
              key={o.tag}
              checked={prefs.cc && prefs.subtitleLang === o.tag}
              onClick={() => pick(o.tag)}
              sub={READINESS_NOTE[readiness(o.tag)]}
            >
              <span lang={o.tag} dir={o.dir}>
                {o.autonym}
              </span>
              {o.local !== o.autonym ? <span className="tt-menu-local"> · {o.local}</span> : null}
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
      <button type="button" className="tt-menu-item" onClick={() => setUi({ menu: "style" })}>
        <span>Style</span>
        <span className="tt-menu-sub">
          {SUBTITLE_PRESETS[prefs.style.preset].label} · {prefs.style.size}px ›
        </span>
      </button>
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
        sub={tracks.describe ? "each new slide read aloud" : "not in this room yet"}
      >
        Speaker and slide descriptions
      </Choice>
    </Menu>
  );
}

export function StyleMenu() {
  const { prefs, update, setUi } = usePlayer();
  const style = prefs.style;
  const setStyle = (change: Partial<typeof style>) => update((p) => ({ style: { ...p.style, ...change } }));
  return (
    <Menu label="Subtitle style" wide>
      <button type="button" className="tt-menu-item tt-menu-back" onClick={() => setUi({ menu: "cc" })}>
        <Icon name="back" />
        <span>Subtitles</span>
      </button>
      <span className="tt-menu-heading">Preset</span>
      <div className="tt-presets">
        {(Object.keys(SUBTITLE_PRESETS) as SubtitlePreset[]).map((preset) => (
          <button
            key={preset}
            type="button"
            className="tt-preset"
            data-preset={preset}
            aria-pressed={style.preset === preset}
            onClick={() => {
              const large = SUBTITLE_PRESETS[preset].size;
              setStyle({ preset, size: large ? Math.max(style.size, large) : style.size });
            }}
          >
            {SUBTITLE_PRESETS[preset].label}
          </button>
        ))}
      </div>
      <div className="tt-slider-row">
        <label htmlFor="tt-sub-size">Size</label>
        <input
          id="tt-sub-size"
          type="range"
          min={12}
          max={44}
          value={style.size}
          onChange={(e) => setStyle({ size: Number(e.target.value) })}
        />
        <input
          className="tt-input tt-number"
          type="number"
          min={12}
          max={44}
          aria-label="Size in pixels"
          value={style.size}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setStyle({ size: Math.min(44, Math.max(12, Math.round(v))) });
          }}
        />
      </div>
      <div className="tt-slider-row">
        <label htmlFor="tt-sub-bg">Background</label>
        <input
          id="tt-sub-bg"
          type="range"
          min={0}
          max={100}
          value={Math.round(style.background * 100)}
          aria-valuetext={`${Math.round(style.background * 100)} %`}
          onChange={(e) => setStyle({ background: Number(e.target.value) / 100 })}
        />
        <span className="tt-slider-value">{Math.round(style.background * 100)} %</span>
      </div>
      <span className="tt-menu-heading">Lines shown</span>
      <div className="tt-segmented" role="group" aria-label="Lines shown">
        {([1, 2, 3] as const).map((n) => (
          <button key={n} type="button" aria-pressed={style.lines === n} onClick={() => setStyle({ lines: n })}>
            {n}
          </button>
        ))}
      </div>
      <Choice checked={style.interim} onClick={() => setStyle({ interim: !style.interim })}>
        Show words as they form
      </Choice>
      <button type="button" className="tt-menu-item" onClick={() => update({ subtitlePos: undefined })}>
        Reset position
      </button>
      <button type="button" className="tt-menu-item" onClick={() => update({ style: DEFAULT_STYLE })}>
        Reset style
      </button>
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

/** Settings opens things; it switches nothing on (decision 0026): the tracks follow what is picked and open. */
export function SettingsMenu() {
  const { setUi } = usePlayer();
  return (
    <Menu label="Settings" wide>
      <button type="button" className="tt-menu-item" onClick={() => setUi({ menu: "style" })}>
        <span>Subtitle style</span>
        <span className="tt-menu-sub">›</span>
      </button>
      <button type="button" className="tt-menu-item" onClick={() => setUi({ stats: true, menu: undefined })}>
        <span>Stats for nerds</span>
        <span className="tt-menu-sub">right-click the stage</span>
      </button>
      <button type="button" className="tt-menu-item" onClick={() => setUi({ shortcuts: true, menu: undefined })}>
        <span>Keyboard shortcuts</span>
        <span className="tt-menu-sub">?</span>
      </button>
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

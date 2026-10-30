// The control bar's menus (ui-design §3.1, §4.1–§4.2, §4.7): subtitles with the language search and the
// style submenu, layout, settings. Each is a small dialog of ordinary buttons and inputs, so Tab reaches
// everything; the subtitle style previews live on the canvas while its menu is open.

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { languageOption, searchLanguages, SUPPORTED_LANGUAGES } from "./languages";
import { DEFAULT_STYLE, type LayoutKind, type SubtitlePreset, SUBTITLE_PRESETS } from "./prefs";
import { effectiveLayout } from "./Stage";
import { translationFor } from "./tracks";

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
  const { prefs, update, tracks, setUi } = usePlayer();
  const [query, setQuery] = useState("");
  const original = tracks.captions;
  const originalName = languageOption(original?.lang ?? "en").local;
  const inRoom = tracks.translations.map((t) => t.lang!).filter(Boolean);
  const all = useMemo(() => SUPPORTED_LANGUAGES.map((tag) => languageOption(tag)), []);
  const roomOptions = inRoom.map((tag) => languageOption(tag));
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
          const offered = translationFor(tracks, o.tag) !== undefined;
          return (
            <Choice
              key={o.tag}
              checked={prefs.cc && prefs.subtitleLang === o.tag}
              onClick={() => pick(o.tag)}
              sub={offered ? "in this room" : undefined}
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

const LAYOUTS: [LayoutKind, string][] = [
  ["single", "Single"],
  ["split", "Split: camera and slides"],
  ["pip", "Picture-in-picture"],
];

export function LayoutMenu() {
  const { prefs, update, sources, setUi } = usePlayer();
  const layout = effectiveLayout(prefs.layout, sources);
  const close = () => setUi({ menu: undefined });
  return (
    <Menu label="Layout">
      {LAYOUTS.map(([value, label]) => (
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
          <Choice checked={prefs.single === "slides"} onClick={() => update({ single: "slides" })}>
            Slides
          </Choice>
          <Choice checked={prefs.single === "camera"} onClick={() => update({ single: "camera" })}>
            Camera
          </Choice>
        </>
      ) : (
        <button type="button" className="tt-menu-item" onClick={() => update({ swap: !prefs.swap })}>
          Swap camera and slides
        </button>
      )}
    </Menu>
  );
}

export function SettingsMenu() {
  const { prefs, update, setUi, ui, tracks } = usePlayer();
  return (
    <Menu label="Settings" wide>
      <button type="button" className="tt-menu-item" onClick={() => setUi({ menu: "style" })}>
        <span>Subtitle style</span>
        <span className="tt-menu-sub">›</span>
      </button>
      <Choice
        checked={prefs.chapters}
        onClick={() => update({ chapters: !prefs.chapters })}
        sub={tracks.outline ? "chapters on the bar, recap" : "not in this room yet"}
      >
        Chapters and glossary
      </Choice>
      <span className="tt-menu-heading">Slide descriptions</span>
      <div className="tt-segmented" role="group" aria-label="Slide descriptions">
        {(
          [
            ["off", "Off"],
            ["text", "Text"],
            ["speak", "Read aloud"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={prefs.describe === value}
            onClick={() => {
              if (value === "speak") unlockSpeech();
              update({ describe: value });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="tt-menu-heading">Ink and marks on slides</span>
      <div className="tt-segmented" role="group" aria-label="Ink and marks on slides">
        {(
          [
            ["everyone", "Everyone's"],
            ["speaker", "Speaker's only"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={prefs.annotations === value}
            onClick={() => update({ annotations: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <Choice checked={ui.stats} onClick={() => setUi({ stats: !ui.stats, menu: undefined })}>
        Stats for nerds
      </Choice>
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

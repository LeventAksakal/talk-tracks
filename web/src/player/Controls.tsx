// The player's controls (decision 0031), laid out like a streaming player in one glass dock: the time range, then
// play, volume and time on the left, with the LIVE pill (Go live when behind) and the current chapter; on the
// right subtitles, layout, side panel, settings (speed, quality, subtitle size and style: only real settings),
// picture-in-picture and full screen. Media Chrome draws and labels the media controls; the room's own (Go live,
// subtitles and translations, layout, panel) are ordinary buttons beside them.

import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { fold } from "./languages";
import { CaptionsMenu, LayoutMenu } from "./menus";
import { DEFAULT_STYLE, type SubtitlePreset, SUBTITLE_PRESETS } from "./prefs";
import { chapterAt, holesIn } from "./timeline";
import { transcriptLines } from "./tracks";

const noop = () => () => {};
const zero = () => 0;

/** Subtitle sizes offered in Settings, px (the [ and ] keys step between 12 and 44). */
export const SUBTITLE_SIZES: [number, string][] = [
  [20, "Small"],
  [26, "Medium"],
  [32, "Large"],
  [40, "Extra large"],
];

const RATES = "0.5 0.75 1 1.25 1.5 2";

export function Controls({ quality }: { quality: boolean }) {
  const { ui, setUi, prefs, update, state, at, goLive, openTab, tracks, sources } = usePlayer();
  const chapters = tracks.outline?.enabled ? (tracks.outline.outline?.chapters ?? []) : [];
  const chapter = chapterAt(chapters, at);
  const toggleMenu = (menu: NonNullable<typeof ui.menu>) =>
    setUi((u) => ({ menu: u.menu === menu ? undefined : menu }));

  return (
    <>
      <SettingsMenu quality={quality} />
      <div className="tt-dock">
        <media-control-bar className="tt-bar tt-bar-range">
          <TimeRange />
        </media-control-bar>
        <media-control-bar className="tt-bar" data-menu-root="">
          <media-play-button className="tt-mc-button">
            {/* At a recording's end the play button replays it from the start. */}
            {state.card?.replay ? <Icon name="replay" slot="play" /> : null}
          </media-play-button>
          <span className="tt-volume">
            <media-mute-button className="tt-mc-button" />
            <media-volume-range className="tt-volume-range" />
          </span>
          {/* Text, not a button: a toggle's fixed name ("playback time") would not match the time it shows. */}
          <media-time-display className="tt-time" notoggle="" showduration={state.recording ? "" : undefined} />
          {state.canGoLive ? (
            <button type="button" className="tt-pill tt-pill-behind" onClick={goLive} title="Go live (G)">
              {state.pill} · Go live
            </button>
          ) : (
            <span className={`tt-pill${state.kind === "live" ? " tt-pill-live" : ""}`} role="status">
              {state.kind === "live" ? <Icon name="live" /> : null}
              {state.pill}
            </span>
          )}
          {chapter ? (
            <button type="button" className="tt-chapter-name" onClick={() => openTab("chapters")}>
              {chapter.title} ›
            </button>
          ) : null}
          <span className="tt-bar-spacer" />
          <button
            type="button"
            className={`tt-bar-button${prefs.cc ? " tt-on" : ""}`}
            aria-label="Subtitles"
            aria-haspopup="dialog"
            aria-expanded={ui.menu === "cc"}
            onClick={() => toggleMenu("cc")}
          >
            <Icon name="cc" />
          </button>
          {sources.length > 1 ? (
            <button
              type="button"
              className="tt-bar-button"
              aria-label="Layout"
              aria-haspopup="dialog"
              aria-expanded={ui.menu === "layout"}
              onClick={() => toggleMenu("layout")}
            >
              <Icon name="layout" />
            </button>
          ) : null}
          <button
            type="button"
            className="tt-bar-button"
            aria-label="Side panel (S)"
            aria-pressed={prefs.panel}
            onClick={() => update({ panel: !prefs.panel })}
          >
            <Icon name="panel" />
          </button>
          <media-settings-menu-button className="tt-mc-button">
            <Icon name="gear" slot="icon" />
          </media-settings-menu-button>
          <media-pip-button className="tt-mc-button" />
          <media-fullscreen-button className="tt-mc-button" />
          {ui.menu === "cc" ? <CaptionsMenu /> : null}
          {ui.menu === "layout" ? <LayoutMenu /> : null}
        </media-control-bar>
      </div>
    </>
  );
}

/**
 * Settings (decision 0031): speed, quality where the stream has more than one, subtitle size and style. Nothing else:
 * features follow what is picked and open (decision 0026); Stats for nerds is a right-click on the stage, the keys
 * are `?`.
 */
function SettingsMenu({ quality }: { quality: boolean }) {
  const { prefs, update } = usePlayer();
  const size = useRef<HTMLElement>(null);
  const look = useRef<HTMLElement>(null);
  useEffect(() => {
    const s = size.current;
    const l = look.current;
    const onSize = () => {
      const v = Number((s as unknown as { value: string } | null)?.value);
      if (Number.isFinite(v) && v > 0) update((p) => ({ style: { ...p.style, size: v } }));
    };
    const onLook = () => {
      const v = (l as unknown as { value: string } | null)?.value as SubtitlePreset | undefined;
      if (v && v in SUBTITLE_PRESETS) update((p) => ({ style: { ...p.style, preset: v } }));
    };
    s?.addEventListener("change", onSize);
    l?.addEventListener("change", onLook);
    return () => {
      s?.removeEventListener("change", onSize);
      l?.removeEventListener("change", onLook);
    };
  }, [update]);
  const closest = SUBTITLE_SIZES.reduce((a, b) =>
    Math.abs(b[0] - prefs.style.size) < Math.abs(a[0] - prefs.style.size) ? b : a,
  );
  return (
    <media-settings-menu hidden anchor="auto" className="tt-settings">
      <media-settings-menu-item>
        Speed
        <media-playback-rate-menu slot="submenu" hidden rates={RATES}>
          <div slot="title">Speed</div>
        </media-playback-rate-menu>
      </media-settings-menu-item>
      {quality ? (
        <media-settings-menu-item>
          Quality
          <media-rendition-menu slot="submenu" hidden>
            <div slot="title">Quality</div>
          </media-rendition-menu>
        </media-settings-menu-item>
      ) : null}
      <media-settings-menu-item>
        Subtitle size
        <media-chrome-menu ref={size} slot="submenu" hidden>
          <div slot="title">Subtitle size</div>
          {SUBTITLE_SIZES.map(([px, label]) => (
            <media-chrome-menu-item
              key={px}
              type="radio"
              value={String(px)}
              aria-checked={closest[0] === px ? "true" : "false"}
              checked={closest[0] === px}
            >
              {label}
            </media-chrome-menu-item>
          ))}
        </media-chrome-menu>
      </media-settings-menu-item>
      <media-settings-menu-item>
        Subtitle style
        <media-chrome-menu ref={look} slot="submenu" hidden>
          <div slot="title">Subtitle style</div>
          {(Object.keys(SUBTITLE_PRESETS) as SubtitlePreset[]).map((preset) => (
            <media-chrome-menu-item
              key={preset}
              type="radio"
              value={preset}
              aria-checked={prefs.style.preset === preset ? "true" : "false"}
              checked={prefs.style.preset === preset}
            >
              {SUBTITLE_PRESETS[preset].label}
            </media-chrome-menu-item>
          ))}
        </media-chrome-menu>
      </media-settings-menu-item>
      {prefs.style.size !== DEFAULT_STYLE.size || prefs.style.preset !== DEFAULT_STYLE.preset ? (
        <media-chrome-menu-item onClick={() => update({ style: DEFAULT_STYLE })}>
          Reset subtitles
        </media-chrome-menu-item>
      ) : null}
    </media-settings-menu>
  );
}

/**
 * Media Chrome's time range (chapter segments from the element's chapters track), with the room's marks laid over it
 * (holes where nobody broadcast, slide changes, notes, transcript search matches) and a preview of the slide at the
 * pointer.
 */
function TimeRange() {
  const { view, tracks, notes, ui, origin, slides: slideTracks, slidesShown } = usePlayer();
  const deck = slidesShown ? slideTracks : undefined;
  useSyncExternalStore(deck?.subscribe ?? noop, deck?.getVersion ?? zero);
  const t = view.timeline;
  const range = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<number>();
  useEffect(() => {
    const el = range.current;
    const controller = el?.closest("media-controller");
    if (!controller) return;
    const onPreview = (e: Event) => {
      const s = (e as CustomEvent<number | null | undefined>).detail;
      setPreview(typeof s === "number" && Number.isFinite(s) ? s * 1000 + origin : undefined);
    };
    controller.addEventListener("mediapreviewrequest", onPreview);
    return () => controller.removeEventListener("mediapreviewrequest", onPreview);
  }, [origin]);

  const end = t.liveEdge ?? t.position ?? 0;
  const start = Math.min(Math.max(origin, t.start), end);
  const span = Math.max(1, end - start);
  const frac = (ms: number) => Math.min(1, Math.max(0, (ms - start) / span));
  const inSpan = (ms: number) => ms >= start && ms <= end;
  const slideMarks = tracks.describe?.enabled ? (tracks.describe.sliced?.slides ?? []) : [];
  const query = fold(ui.search.trim());
  const matches = query.length >= 2 ? transcriptLines(tracks.captions).filter((l) => fold(l.text).includes(query)) : [];
  const shown = preview !== undefined && deck ? deck.previewAt(preview) : undefined;
  const thumb = shown && deck ? deck.picture(shown.deck, shown.index) : undefined;
  const at = (ms: number) => ({ left: `${frac(ms) * 100}%` }) as CSSProperties;

  return (
    <div className="tt-range-wrap">
      <media-time-range ref={range} className="tt-range">
        <div slot="preview" className="tt-preview">
          {thumb ? (
            <img className="tt-preview-thumb" src={thumb.url} alt="" data-slide={thumb.image.index + 1} />
          ) : shown ? (
            <span className="tt-preview-thumb tt-preview-slide">Slide {shown.index + 1}</span>
          ) : null}
          <media-preview-chapter-display className="tt-preview-chapter" />
          <media-preview-time-display className="tt-preview-time" />
        </div>
      </media-time-range>
      <div className="tt-marks" aria-hidden="true">
        {holesIn(t.available, start, end).map((h) => (
          <span
            key={`h${h.start}`}
            className="tt-hole"
            style={{ left: `${frac(h.start) * 100}%`, width: `${(frac(h.end) - frac(h.start)) * 100}%` }}
          />
        ))}
        {slideMarks
          .filter((s) => inSpan(s.atMs))
          .map((s) => (
            <span key={`s${s.id}:${s.atMs}`} className="tt-mark tt-mark-slide" style={at(s.atMs)} />
          ))}
        {notes.notes
          .filter((n) => inSpan(n.at))
          .map((n) => (
            <span key={`n${n.id}`} className="tt-mark tt-mark-note" style={at(n.at)} />
          ))}
        {matches
          .filter((l) => inSpan(l.startMs))
          .map((l) => (
            <span key={`m${l.id}`} className="tt-mark tt-mark-match" style={at(l.startMs)} />
          ))}
      </div>
    </div>
  );
}

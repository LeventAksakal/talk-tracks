import { formatClock } from "../playback/timeline";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { CaptionsMenu, LayoutMenu, SettingsMenu, StyleMenu } from "./menus";
import { chapterAt } from "./timeline";

/**
 * The control bar (ui-design §3.1), by convention: playback on the left (play, volume, time with the LIVE
 * pill or the offset that goes live, the current chapter), features and view on the right (subtitles,
 * layout, side panel, settings, fullscreen).
 */
export function ControlBar({ fullscreen, onFullscreen }: { fullscreen: boolean; onFullscreen: () => void }) {
  const { media, ui, setUi, prefs, update, state, at, goLive, togglePlay, openTab, tracks, sources } = usePlayer();
  const chapters = tracks.outline?.enabled ? (tracks.outline.outline?.chapters ?? []) : [];
  const chapter = chapterAt(chapters, at);
  const toggleMenu = (menu: NonNullable<typeof ui.menu>) =>
    setUi((u) => ({ menu: u.menu === menu || (menu === "cc" && u.menu === "style") ? undefined : menu }));

  return (
    <div className="tt-controls" data-menu-root>
      <div className="tt-controls-left">
        {media ? (
          <button
            type="button"
            className="tt-icon-button"
            aria-label={ui.playing ? "Pause (K)" : "Play (K)"}
            onClick={togglePlay}
          >
            <Icon name={ui.playing ? "pause" : "play"} />
          </button>
        ) : null}
        {media ? (
          <div className="tt-volume">
            <button
              type="button"
              className="tt-icon-button"
              aria-label={prefs.muted ? "Unmute" : "Mute"}
              aria-pressed={prefs.muted}
              onClick={() => update({ muted: !prefs.muted })}
            >
              <Icon name={prefs.muted || prefs.volume === 0 ? "muted" : "volume"} />
            </button>
            <input
              type="range"
              className="tt-volume-slider"
              min={0}
              max={100}
              aria-label="Volume"
              value={Math.round((prefs.muted ? 0 : prefs.volume) * 100)}
              onChange={(e) => update({ volume: Number(e.target.value) / 100, muted: false })}
            />
          </div>
        ) : null}
        <span className="tt-time" aria-label="Time in the talk">
          {at === undefined ? "–:––" : formatClock(at)}
          {state.recording ? ` / ${formatClock(state.recording.end)}` : null}
        </span>
        {state.canGoLive ? (
          <button type="button" className="tt-pill tt-pill-behind" onClick={goLive} title="Go live (G)">
            {state.pill} · Go live
          </button>
        ) : (
          <span className={`tt-pill${state.kind === "live" ? " tt-pill-live" : ""}`} role="status">
            {state.pill}
          </span>
        )}
        {chapter ? (
          <button type="button" className="tt-chapter-name" onClick={() => openTab("chapters")}>
            · {chapter.title} ›
          </button>
        ) : null}
      </div>

      <div className="tt-controls-right">
        <button
          type="button"
          className={`tt-icon-button${prefs.cc ? " tt-on" : ""}`}
          aria-label="Subtitles"
          aria-haspopup="dialog"
          aria-expanded={ui.menu === "cc" || ui.menu === "style"}
          onClick={() => toggleMenu("cc")}
        >
          <Icon name="cc" />
        </button>
        {sources.length > 1 ? (
          <button
            type="button"
            className="tt-icon-button"
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
          className="tt-icon-button"
          aria-label="Side panel (S)"
          aria-pressed={prefs.panel}
          onClick={() => update({ panel: !prefs.panel })}
        >
          <Icon name="panel" />
        </button>
        <button
          type="button"
          className="tt-icon-button"
          aria-label="Settings"
          aria-haspopup="dialog"
          aria-expanded={ui.menu === "settings"}
          onClick={() => toggleMenu("settings")}
        >
          <Icon name="gear" />
        </button>
        <button
          type="button"
          className="tt-icon-button"
          aria-label={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}
          onClick={onFullscreen}
        >
          <Icon name={fullscreen ? "exitFullscreen" : "fullscreen"} />
        </button>
      </div>

      {ui.menu === "cc" ? <CaptionsMenu /> : null}
      {ui.menu === "style" ? <StyleMenu /> : null}
      {ui.menu === "layout" ? <LayoutMenu /> : null}
      {ui.menu === "settings" ? <SettingsMenu /> : null}
    </div>
  );
}

// The player's controls, laid out like Google Meet's bottom bar for a lecture (owner QA, 2026-11-04): the time range
// across the top of the bar; then the time, the LIVE pill (Go live when behind) and the current chapter on the left;
// play, volume (a slider beside the speaker), subtitles and More options as round buttons in the centre; the side
// panel buttons (Chat, Transcript, Chapters, Discussion) on the right, each opening its panel in the card on the
// right. Listeners only listen and read: no microphone, camera or hand. More options holds Adjust view, full screen,
// picture-in-picture, Settings (speed, quality, subtitle size and style) and the keyboard shortcuts. Media Chrome
// draws and labels the media controls; the room's own are ordinary buttons beside them.

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { usePlayer } from "./context";
import { Icon, type IconName } from "./icons";
import { fold } from "./languages";
import { CaptionsMenu } from "./menus";
import { MediaUIEvents } from "./mediaChrome";
import { AdjustView } from "./workspace/Workspace";
import { isPicture, type PanelId } from "./workspace/layout";
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

/** The side panel buttons' icons; a later lane's panel gets the generic one. */
const PANEL_ICON: Record<string, IconName> = {
  chat: "chat",
  transcript: "notes",
  chapters: "bulletedList",
  discussion: "discussion",
};

export function Controls({ quality }: { quality: boolean }) {
  const { ui, setUi, prefs, state, at, goLive, openTab, tracks, workspace } = usePlayer();
  const chapters = tracks.outline?.enabled ? (tracks.outline.outline?.chapters ?? []) : [];
  const chapter = chapterAt(chapters, at);
  const toggleMenu = (menu: NonNullable<typeof ui.menu>) =>
    setUi((u) => ({ menu: u.menu === menu ? undefined : menu }));
  const panels = workspace.available.filter((id) => !isPicture(id));

  return (
    <>
      <SettingsMenu quality={quality} />
      <div className="tt-dock">
        <media-control-bar className="tt-bar tt-bar-range">
          <TimeRange />
        </media-control-bar>
        <div className="tt-bar tt-bar-main" data-menu-root="">
          <div className="tt-bar-side tt-bar-left">
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
                <span>{chapter.title}</span>
                <Icon name="forward" />
              </button>
            ) : null}
          </div>
          <div className="tt-bar-centre">
            <media-play-button className="tt-mc-button tt-round">
              {/* At a recording's end the play button replays it from the start. */}
              <Icon name={state.card?.replay ? "replay" : "play"} slot="play" />
              <Icon name="pause" slot="pause" />
            </media-play-button>
            <Volume />
            <button
              type="button"
              className={`tt-bar-button tt-round${prefs.cc ? " tt-on" : ""}`}
              aria-label="Subtitles"
              title="Subtitles (C)"
              aria-haspopup="dialog"
              aria-expanded={ui.menu === "cc"}
              onClick={() => toggleMenu("cc")}
            >
              <Icon name={prefs.cc ? "ccOn" : "cc"} />
            </button>
            <button
              type="button"
              className="tt-bar-button tt-round"
              aria-label="More options"
              title="More options"
              aria-haspopup="menu"
              aria-expanded={ui.menu === "more"}
              onClick={() => toggleMenu("more")}
            >
              <Icon name="more" />
            </button>
            {ui.menu === "cc" ? <CaptionsMenu /> : null}
            {ui.menu === "more" ? <MoreMenu onDone={() => setUi({ menu: undefined })} /> : null}
          </div>
          <div className="tt-bar-side tt-bar-right" role="group" aria-label="Side panels">
            {panels.map((id) => (
              <PanelButton key={id} id={id} />
            ))}
          </div>
        </div>
      </div>
      {ui.menu === "view" ? (
        // Meet's dialog over a dimmed stage; a press on the dim closes it (the player closes menus on a press outside).
        <div className="tt-view-layer">
          <AdjustView api={workspace} onDone={() => setUi({ menu: undefined })} />
        </div>
      ) : null}
    </>
  );
}

/** A side panel button: opens its panel in the card on the right, or closes it. */
function PanelButton({ id }: { id: PanelId }) {
  const { workspace } = usePlayer();
  const label = workspace.label(id);
  const on = workspace.visible.has(id);
  return (
    <button
      type="button"
      className="tt-bar-button tt-panel-button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      data-panel={id}
      onClick={() => workspace.togglePanel(id)}
    >
      <Icon name={PANEL_ICON[id] ?? "panel"} />
    </button>
  );
}

/**
 * Volume: the speaker button mutes and unmutes; the slider beside it opens on hover or focus and stays open while
 * it is used (arrow keys step it, as the controller's up and down keys do).
 */
function Volume() {
  return (
    <span className="tt-volume" role="group" aria-label="Volume">
      <media-mute-button className="tt-mc-button tt-round">
        <Icon name="muted" slot="off" />
        <Icon name="volumeLow" slot="low" />
        <Icon name="volumeLow" slot="medium" />
        <Icon name="volume" slot="high" />
      </media-mute-button>
      <media-volume-range className="tt-volume-range" />
    </span>
  );
}

/**
 * More options (Meet's ⋮ menu): Adjust view, full screen, picture-in-picture where the browser has it, Settings and
 * the keyboard shortcuts.
 */
function MoreMenu({ onDone }: { onDone: () => void }) {
  const { setUi } = usePlayer();
  const ref = useRef<HTMLDivElement>(null);
  const controller = () => ref.current?.closest("media-controller") ?? null;
  const [full] = useState(() => document.fullscreenElement !== null);
  const [pip] = useState(() => document.pictureInPictureElement != null);
  const [pipOk] = useState(
    () => typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled,
  );
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
  }, []);
  const request = (type: string) => {
    ref.current?.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
    onDone();
  };
  // Arrow keys walk the items.
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + step + items.length) % items.length]?.focus();
  };
  const openSettings = () => {
    onDone();
    const menu = controller()?.querySelector<HTMLElement>("media-settings-menu");
    if (menu) {
      menu.hidden = false;
      requestAnimationFrame(() => menu.focus());
    }
  };
  return (
    <div ref={ref} className="tt-more" role="menu" aria-label="More options" onKeyDown={onKey}>
      <MoreItem icon="view" label="Adjust view" onClick={() => setUi({ menu: "view" })} />
      <MoreItem
        icon={full ? "exitFullscreen" : "fullscreen"}
        label={full ? "Exit full screen" : "Full screen"}
        onClick={() =>
          request(full ? MediaUIEvents.MEDIA_EXIT_FULLSCREEN_REQUEST : MediaUIEvents.MEDIA_ENTER_FULLSCREEN_REQUEST)
        }
      />
      {pipOk ? (
        <MoreItem
          icon="pip"
          label={pip ? "Close picture-in-picture" : "Open picture-in-picture"}
          onClick={() => request(pip ? MediaUIEvents.MEDIA_EXIT_PIP_REQUEST : MediaUIEvents.MEDIA_ENTER_PIP_REQUEST)}
        />
      ) : null}
      <MoreItem icon="gear" label="Settings" onClick={openSettings} />
      <MoreItem
        icon="keyboard"
        label="Keyboard shortcuts"
        onClick={() => setUi({ menu: undefined, shortcuts: true })}
      />
    </div>
  );
}

function MoreItem({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="tt-more-item" onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
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
    <media-settings-menu hidden className="tt-settings">
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
 * (holes where nobody broadcast, slide changes, transcript search matches) and a preview of the slide at the
 * pointer.
 */
function TimeRange() {
  const { view, tracks, ui, origin, slides: slideTracks, slidesShown } = usePlayer();
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
        {matches
          .filter((l) => inSpan(l.startMs))
          .map((l) => (
            <span key={`m${l.id}`} className="tt-mark tt-mark-match" style={at(l.startMs)} />
          ))}
      </div>
    </div>
  );
}

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RoomMedia } from "../playback/media";
import type { Playback } from "../playback/playback";
import { useRoomStatus } from "../playback/roomStatus";
import { formatClock } from "../playback/timeline";
import { usePlaybackView } from "../playback/usePlayback";
import { Link } from "../router";
import type { Transport } from "../transport/types";
import { type ExtraTab, INITIAL_UI, type PlayerCtx, PlayerContext, type UiState } from "./context";
import { ControlBar } from "./ControlBar";
import { FrameClock } from "./frameClock";
import { useNotes } from "./notes";
import "./player.css";
import { type PanelTab, type SourceKind, usePrefs } from "./prefs";
import { ProgressBar } from "./ProgressBar";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { SidePanel } from "./SidePanel";
import { Stage } from "./Stage";
import { forcedInput, playerState, type PlayerStateKind } from "./state";
import { roomTracks, wantedTracks } from "./tracks";

export interface PlayerProps {
  playback: Playback;
  room: string;
  transport: Transport | undefined;
  title?: string;
  speaker?: string;
  /** Credit line under the title (event, licence). */
  credit?: string;
  /** A short note in the title bar ("Offline demo"). */
  notice?: ReactNode;
  /** The pictures to lay out; by default from the room catalog's sources (camera and slides). */
  sources?: SourceKind[];
  /** Later lanes' side panel tabs (Discussion). */
  extraTabs?: ExtraTab[];
  /** Preview a player state (the offline demo's `?state=`). */
  forceState?: PlayerStateKind;
}

/** Controls hide after this long without the pointer moving, in full screen while playing. */
const IDLE_MS = 3_000;

/**
 * The media player (ui-design §3–§4.8, decision 0020): title bar, the canvas with its sources and overlays,
 * the progress bar and control bar, the side panel. It shows the room's state at the playhead from all its
 * tracks, live or rewound, through the playback layer; every AI feature is a player feature the viewer turns
 * on, remembered on this device.
 */
export function Player(props: PlayerProps) {
  const { playback, room, transport, forceState } = props;
  const view = usePlaybackView(playback);
  const status = useRoomStatus(transport, room);
  const [prefs, update] = usePrefs();
  const [ui, setUiState] = useState<UiState>(INITIAL_UI);
  const setUi = useCallback(
    (change: Partial<UiState> | ((u: UiState) => Partial<UiState>)) =>
      setUiState((u) => ({ ...u, ...(typeof change === "function" ? change(u) : change) })),
    [],
  );
  const notes = useNotes(room);
  const clock = useMemo(() => new FrameClock(() => playback.media.frameTime()), [playback]);
  const media = playback.media instanceof RoomMedia ? playback.media : undefined;
  const root = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const title = props.title ?? `Room ${room}`;

  if (status?.status === "connected" && !everConnected) setEverConnected(true);

  const tracks = useMemo(() => roomTracks(view?.tracks.tracks ?? []), [view?.tracks.tracks]);
  const sources = useMemo<SourceKind[]>(() => {
    if (props.sources) return props.sources;
    const listed = media?.catalog()?.tt.sources?.map((s) => s.kind);
    const out: SourceKind[] = [];
    if (!listed || listed.includes("camera") || listed.includes("audio")) out.push("camera");
    if (listed?.includes("slides") || status?.slidesLive) out.push("slides");
    return out;
    // The catalog arrives with media changes, which re-render through the view.
  }, [props.sources, media, status?.slidesLive, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // The tracks the viewer's features need are exactly the ones subscribed (decision 0010).
  const wanted = useMemo(() => wantedTracks(prefs, tracks), [prefs, tracks]);
  const trackIds = (view?.tracks.tracks ?? []).map((t) => `${t.id}:${t.enabled}`).join(",");
  useEffect(() => {
    for (const t of playback.tracks.getSnapshot().tracks) {
      const want = wanted.has(t.id);
      if (t.enabled !== want) playback.tracks.setEnabled(t.id, want);
    }
  }, [playback, wanted, trackIds]);

  const announce = useCallback(
    (message: string) => {
      setAnnouncement(message);
      setUi({ toast: message });
    },
    [setUi],
  );
  useEffect(() => {
    if (!ui.toast) return;
    const timer = setTimeout(() => setUi({ toast: undefined }), 1_800);
    return () => clearTimeout(timer);
  }, [ui.toast, setUi]);

  // Full screen takes the whole player, side panel and overlays included (Fullscreen API).
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === root.current && root.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.current?.requestFullscreen?.().catch(() => {});
  }, []);

  // In full screen, controls and title fade after a while and return on pointer move or focus.
  useEffect(() => {
    if (!fullscreen) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    wake();
    const el = root.current;
    el?.addEventListener("pointermove", wake);
    el?.addEventListener("keydown", wake);
    el?.addEventListener("focusin", wake);
    return () => {
      clearTimeout(timer);
      setIdle(false);
      el?.removeEventListener("pointermove", wake);
      el?.removeEventListener("keydown", wake);
      el?.removeEventListener("focusin", wake);
    };
  }, [fullscreen]);

  // A menu closes on a press outside it.
  useEffect(() => {
    if (!ui.menu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-menu-root]")) setUi({ menu: undefined });
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [ui.menu, setUi]);

  const timeline = view?.timeline;
  const onAir = media?.onAir?.() ?? (status ? status.teacherLive || undefined : undefined);
  const real = {
    connection: status?.status,
    everConnected: everConnected || status?.status === "connected",
    onAir,
    mode: timeline?.mode ?? "live",
    liveEdge: timeline?.liveEdge,
    behindMs: timeline?.behindMs ?? 0,
    slowerPath: false,
    speaker: props.speaker,
  } as const;
  const state = playerState({ ...real, ...(forceState ? forcedInput(forceState) : {}) });
  const at = timeline
    ? timeline.mode === "live"
      ? (timeline.position ?? timeline.liveEdge)
      : timeline.position
    : undefined;

  const togglePlay = useCallback(() => {
    if (!media) return;
    if (ui.playing) media.stop();
    else media.play();
    setUi({ playing: !ui.playing });
  }, [media, ui.playing, setUi]);

  const openTab = useCallback((tab: PanelTab) => update({ panel: true, tab }), [update]);
  const addBookmark = useCallback(() => {
    if (at === undefined) return;
    const slide = tracks.describe?.enabled ? tracks.describe.sliced?.slide : undefined;
    notes.add({ at, text: "", slide: slide ? slide.id + 1 : undefined });
    announce(`Bookmark at ${formatClock(at)}`);
  }, [at, tracks.describe, notes, announce]);

  useReadAloud(prefs.describe === "speak", tracks.describe?.sliced?.slide, timeline?.mode === "live");

  const ctx: PlayerCtx | undefined =
    view && timeline
      ? {
          playback,
          view,
          media,
          transport,
          roomName: room,
          title,
          tracks,
          prefs,
          update,
          ui,
          setUi,
          state,
          clock,
          notes,
          sources,
          extraTabs: props.extraTabs ?? [],
          at,
          seek: (ms) => playback.seek(ms),
          goLive: () => playback.goLive(),
          openTab,
          togglePlay,
          addBookmark,
          announce,
        }
      : undefined;

  useShortcuts(ctx, toggleFullscreen);

  if (!ctx) return <p className="tt-loading">Connecting…</p>;

  return (
    <PlayerContext.Provider value={ctx}>
      <div
        ref={root}
        id="main"
        className={`tt-player${prefs.panel ? " tt-with-panel" : ""}${fullscreen ? " tt-fullscreen" : ""}${
          idle && !ui.menu ? " tt-idle" : ""
        }`}
        data-state={state.kind}
      >
        <header className="tt-titlebar">
          <Link href="/" className="tt-brand">
            Talk Tracks
          </Link>
          <h1 className="tt-title">{title}</h1>
          {props.speaker || props.credit ? (
            <span className="tt-credit">{[props.speaker, props.credit].filter(Boolean).join(" · ")}</span>
          ) : null}
          {props.notice ? <span className="tt-notice">{props.notice}</span> : null}
        </header>
        <div className="tt-main">
          <Stage />
          <div className="tt-chrome">
            <ProgressBar />
            <ControlBar fullscreen={fullscreen} onFullscreen={toggleFullscreen} />
          </div>
        </div>
        {prefs.panel ? <SidePanel /> : null}
        {ui.shortcuts ? <ShortcutsDialog onClose={() => setUi({ shortcuts: false })} /> : null}
        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>
      </div>
    </PlayerContext.Provider>
  );
}

/** Keyboard shortcuts of ui-design §4.10, on the whole page (the player is the page). */
function useShortcuts(ctx: PlayerCtx | undefined, toggleFullscreen: () => void): void {
  const latest = useRef(ctx);
  useEffect(() => {
    latest.current = ctx;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = latest.current;
      if (!c || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) {
        if (e.key === "Escape") c.setUi({ menu: undefined });
        return;
      }
      const onButton = target?.closest("button, a, [role='slider'], [role='separator'], [role='tab']");
      const { playback, prefs, update, setUi } = c;
      switch (e.key) {
        case " ":
          if (onButton) return;
          c.togglePlay();
          break;
        case "k":
        case "K":
          c.togglePlay();
          break;
        case "ArrowLeft":
          playback.seekBy(-5_000);
          break;
        case "ArrowRight":
          playback.seekBy(5_000);
          break;
        case "j":
        case "J":
          playback.seekBy(-10_000);
          break;
        case "l":
        case "L":
          playback.seekBy(10_000);
          break;
        case "g":
        case "G":
          c.goLive();
          break;
        case "c":
        case "C":
          update({ cc: !prefs.cc });
          c.announce(prefs.cc ? "Subtitles off" : "Subtitles on");
          break;
        case "[":
        case "]": {
          const size = Math.min(44, Math.max(12, prefs.style.size + (e.key === "]" ? 2 : -2)));
          update({ style: { ...prefs.style, size } });
          c.announce(`Subtitle size ${size}`);
          break;
        }
        case "s":
        case "S":
          update({ panel: !prefs.panel });
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "b":
        case "B":
          c.addBookmark();
          break;
        case "n":
        case "N":
          c.openTab("notes");
          setUi((u) => ({ focusNote: u.focusNote + 1 }));
          break;
        case "/":
          update({ panel: true, tab: "transcript", transcript: true });
          setUi((u) => ({ focusSearch: u.focusSearch + 1 }));
          break;
        case "?":
          setUi({ shortcuts: true, menu: undefined });
          break;
        case "Escape":
          setUi({ menu: undefined, shortcuts: false });
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleFullscreen]);
}

/** Settings → Slide descriptions → Read aloud: each new slide's description, live, in the browser's voice. */
function useReadAloud(on: boolean, slide: { id: number; description: string } | undefined, live: boolean): void {
  const spoken = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!slide) return;
    const first = spoken.current === undefined;
    if (spoken.current === slide.id) return;
    spoken.current = slide.id;
    if (!on || !live || first) return;
    try {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(slide.description));
    } catch {
      // No speech synthesis: the description stays on the slide as text.
    }
  }, [on, slide, live]);
}

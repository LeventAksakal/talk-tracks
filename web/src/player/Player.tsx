import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RoomMedia } from "../playback/media";
import type { Playback } from "../playback/playback";
import { useRoomStatus } from "../playback/roomStatus";
import { formatClock } from "../playback/timeline";
import { usePlaybackView } from "../playback/usePlayback";
import { useResource } from "../useResource";
import { Link } from "../router";
import type { Transport } from "../transport/types";
import type { RoomService, ServiceStatus } from "../annotate/client";
import { DISCUSSION_TAB } from "./Annotate";
import { type ExtraTab, INITIAL_UI, type PlayerCtx, PlayerContext, type UiState } from "./context";
import { ControlBar } from "./ControlBar";
import { Discussion } from "./Discussion";
import { FrameClock } from "./frameClock";
import { Listening, useListening, useRoomService } from "./listening";
import { useNotes } from "./notes";
import "./player.css";
import { type PanelTab, type SourceKind, usePrefs } from "./prefs";
import { ProgressBar } from "./ProgressBar";
import { ScreenMedia } from "./screenMedia";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { SidePanel } from "./SidePanel";
import type { SlideTracks } from "./slideTracks";
import { sourceShown, Stage } from "./Stage";
import { forcedInput, playerState, type PlayerStateKind } from "./state";
import { Linger, roomTracks, openTab as shownTab, wantedSlideTracks, wantedTracks } from "./tracks";

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
  /** The room's slide, annotation and room tracks (deck, slide, ink, marks, laser; the room's state). */
  slides?: SlideTracks;
  /** The room service's endpoint for listeners: annotation tools and the Discussion tab (decision 0024). */
  roomService?: RoomService;
  /**
   * Why this room has no room service (a looped demo room): the Discussion tab says so in place of the
   * discussion, and the annotation tools stay hidden.
   */
  noRoomService?: string;
  /** A recorded talk looped as if live (a demo room): its live state says so. */
  looped?: boolean;
}

const noop = () => () => {};
const zero = () => 0;

/** A connected relay that shows nothing of a room for this long means there is no such room. */
const UNKNOWN_AFTER_MS = 6_000;

/** Controls hide after this long without the pointer moving, in full screen while playing. */
const IDLE_MS = 3_000;

/**
 * The media player (ui-design §3–§4.8, decision 0020): title bar, the canvas with its sources and overlays,
 * the progress bar and control bar, the side panel. It shows the room's state at the playhead from all its
 * tracks, live or rewound, through the playback layer. Every AI feature is a player feature with no switch: a
 * subtitle language picked, a panel open or a sound chosen subscribes its track (decision 0026).
 */
export function Player(props: PlayerProps) {
  const { playback, room, transport, forceState, slides } = props;
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
  useSyncExternalStore(slides?.subscribe ?? noop, slides?.getVersion ?? zero);
  // What the room service says about the talk comes first, then what the page knows (a demo lecture's credits).
  const info = slides?.roomInfo();
  const title = info?.title ?? props.title ?? `Room ${room}`;
  const speaker = info?.speaker ?? props.speaker;
  const roomService = props.roomService;
  const listening = useMemo(() => (roomService ? new Listening(roomService) : undefined), [roomService]);
  useRoomService(roomService);
  const toolsOff = listenerToolsOff(roomService?.status(), props.noRoomService);
  // The room service is down (drawing, marks and comments wait for it); the talk itself plays on.
  const serviceDown = roomService?.status() === "waiting" || roomService?.status() === "closed";
  const extraTabs = useMemo<ExtraTab[]>(
    () => [
      ...(roomService || toolsOff
        ? [
            {
              id: DISCUSSION_TAB,
              label: "Discussion",
              content: toolsOff ? (
                <p className="tt-muted tt-tools-off" role="status">
                  {toolsOff}
                </p>
              ) : (
                <Discussion />
              ),
            },
          ]
        : []),
      ...(props.extraTabs ?? []),
    ],
    [roomService, toolsOff, props.extraTabs],
  );

  if (status?.status === "connected" && !everConnected) setEverConnected(true);

  const tracks = useMemo(() => roomTracks(view?.tracks.tracks ?? []), [view?.tracks.tracks]);
  // The shared screen: live from the teacher's catalog, rewound from the archive's screen playlist.
  const screen = useResource(
    () => (media ? new ScreenMedia(transport, room, media) : undefined),
    [media, transport, room],
  );
  const sources = useMemo<SourceKind[]>(() => {
    if (props.sources) return props.sources;
    const listed = media?.catalog()?.tt.sources?.map((s) => s.kind);
    const out: SourceKind[] = [];
    if (!listed || listed.includes("camera") || listed.includes("audio")) out.push("camera");
    if (listed?.includes("slides") || status?.slidesLive) out.push("slides");
    if (screen?.shown()) out.push("screen");
    return out;
    // The catalog arrives with media changes, which re-render through the view.
  }, [props.sources, media, screen, status?.slidesLive, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // What is picked and open decides what is subscribed (decisions 0010, 0026), and a track let go lingers 30 s.
  // The slides count as on while the layout shows them; the audience's ink and marks while the listener shows
  // them (the Discussion tab or their own tools); the room's state is always read.
  const tab = shownTab(prefs);
  // Tracks held for something in progress (a transcript download), on top of what is picked and open.
  const [holds, setHolds] = useState<readonly (readonly string[])[]>([]);
  const holdTracks = useCallback((ids: readonly string[]) => {
    setHolds((h) => [...h, ids]);
    return () => setHolds((h) => h.filter((x) => x !== ids));
  }, []);
  const wanted = useMemo(
    () => new Set([...wantedTracks(prefs, tracks, tab), ...holds.flat()]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the fields wantedTracks reads
    [prefs.cc, prefs.subtitleLang, prefs.dual, prefs.sound, tracks, tab, holds],
  );
  const held = useLingered(wanted);
  const slidesShown = sourceShown("slides", prefs, sources);
  const annotating = useListening(listening)?.annotating ?? false;
  const audienceShown = tab === DISCUSSION_TAB || annotating;
  useEffect(() => {
    slides?.setWanted(wantedSlideTracks(slidesShown, audienceShown));
  }, [slides, slidesShown, audienceShown]);
  // The slide tracks follow the frame on screen (the playhead while rewound media opens).
  useEffect(() => {
    if (!slides) return;
    const tick = (t: number | undefined) =>
      slides.setTime(
        t ?? (playback.media.mode() === "rewound" ? playback.position() : undefined),
        playback.media.mode(),
        playback.liveEdge(),
      );
    tick(clock.now());
    return clock.subscribe(tick);
  }, [slides, clock, playback]);
  useEffect(() => {
    const t = clock.now() ?? (playback.media.mode() === "rewound" ? playback.position() : undefined);
    slides?.setTime(t, playback.media.mode(), playback.liveEdge());
  });

  // Volume and mute drive live sound too (@moq/watch's gain); the archive element follows them in CameraSurface.
  useEffect(() => {
    media?.setVolume(prefs.muted ? 0 : prefs.volume);
  }, [media, prefs.volume, prefs.muted]);
  const trackIds = (view?.tracks.tracks ?? []).map((t) => `${t.id}:${t.enabled}`).join(",");
  useEffect(() => {
    for (const t of playback.tracks.getSnapshot().tracks) {
      const want = held.has(t.id);
      if (t.enabled !== want) playback.tracks.setEnabled(t.id, want);
    }
  }, [playback, held, trackIds]);

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
  const roomNow = slides?.roomNow();
  // Seen on air here, an end reads "Talk ended"; opened after it, "Recorded session".
  const [sawLive, setSawLive] = useState(false);
  if (!sawLive && (roomNow === "on_air" || (roomNow === undefined && onAir === true))) setSawLive(true);
  // Nothing of the room on a connected relay for a while: no speaker, slides, agents, room catalog, room state or
  // archive. A room created but not started has its catalog from the room service, so it reads "Not started".
  const nothing =
    status?.status === "connected" &&
    !status.teacherLive &&
    !status.slidesLive &&
    status.agents.length === 0 &&
    roomNow === undefined &&
    info === undefined &&
    media?.catalog() === undefined &&
    timeline?.liveEdge === undefined;
  const unknown = useHeldFor(nothing, UNKNOWN_AFTER_MS);
  const real = {
    connection: status?.status,
    everConnected: everConnected || status?.status === "connected",
    onAir,
    mode: timeline?.mode ?? "live",
    liveEdge: timeline?.liveEdge,
    behindMs: timeline?.behindMs ?? 0,
    slowerPath: status?.wire === "websocket",
    speaker,
    recording: timeline ? recordingSpan(timeline) : undefined,
    room: roomNow,
    roomAt: timeline?.mode === "rewound" ? slides?.roomAt(timeline.position) : undefined,
    sawLive,
    looped: props.looped,
    known: !unknown,
    roomName: room,
  } as const;
  const state = playerState({ ...real, ...(forceState ? forcedInput(forceState) : {}) });
  const at = timeline
    ? timeline.mode === "live"
      ? (timeline.position ?? timeline.liveEdge)
      : timeline.position
    : undefined;

  const talkClock = (ms: number) => formatClock(media ? media.talkTime(ms) : ms);

  const togglePlay = useCallback(() => {
    if (!media) return;
    if (ui.playing) media.stop();
    else media.play();
    setUi({ playing: !ui.playing });
  }, [media, ui.playing, setUi]);

  // RoomMedia plays the recording as soon as a seek opens it, and takes the next Go live as a wish for live
  // sound; a seek is a gesture, so it starts sound the way Play does.
  const seekWith = (move: () => void) => {
    move();
    if (media && !ui.playing) {
      media.play();
      setUi({ playing: true });
    }
  };

  const openTab = useCallback((tab: PanelTab) => update({ panel: true, tab }), [update]);
  const shownSlide = slidesShown && at !== undefined ? slides?.slideAt(at)?.slide : undefined;
  const described = tracks.describe?.enabled ? tracks.describe.sliced?.slide : undefined;
  const slideNumber = shownSlide ? shownSlide.index + 1 : described ? described.id + 1 : undefined;
  const addBookmark = useCallback(() => {
    if (at === undefined) return;
    notes.add({ at, text: "", slide: slideNumber });
    announce(`Bookmark at ${formatClock(media ? media.talkTime(at) : at)}`);
  }, [at, slideNumber, notes, announce, media]);

  useReadAloud(prefs.sound === "describe", tracks.describe?.sliced?.slide, timeline?.mode === "live");

  const ctx: PlayerCtx | undefined =
    view && timeline
      ? {
          playback,
          view,
          media,
          transport,
          screen,
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
          slides,
          slidesShown,
          audienceShown,
          slideNumber,
          extraTabs,
          // Listener tools only while the room service can take writes (or is still connecting).
          listening: toolsOff ? undefined : listening,
          at,
          talkClock,
          seek: (ms) => seekWith(() => playback.seek(ms)),
          seekBy: (ms) => seekWith(() => playback.seekBy(ms)),
          goLive: () => playback.goLive(),
          openTab,
          holdTracks,
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
          {speaker || props.credit ? (
            <span className="tt-credit">{[speaker, props.credit].filter(Boolean).join(" · ")}</span>
          ) : null}
          <span className="tt-notices">
            {serviceDown ? (
              <span className="tt-notice tt-notice-degraded" role="status" title={toolsOff}>
                Room service unreachable
              </span>
            ) : null}
            {props.notice ? <span className="tt-notice">{props.notice}</span> : null}
          </span>
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

/** The recorded span: archived media first to last, else the scrubber's start to the live edge. */
function recordingSpan(t: { start: number; available: { end: number }[]; liveEdge: number | undefined }) {
  const end = t.available.at(-1)?.end ?? t.liveEdge;
  return end === undefined ? undefined : { start: t.start, end };
}

/**
 * Why listeners cannot draw, mark or comment here, or undefined when they can (or the room service is still being
 * reached). Drawing, marks and comments all go through the room service (decision 0024).
 */
export function listenerToolsOff(status: ServiceStatus | undefined, noService: string | undefined): string | undefined {
  if (status === undefined) return noService;
  switch (status) {
    case "open":
    case "connecting":
      return undefined;
    case "refused":
      return "Drawing, marking and comments are not available in this room.";
    default:
      return "Drawing, marking and comments need the room's service, which cannot be reached now (the talk may not have started). Trying again…";
  }
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
      const { prefs, update, setUi } = c;
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
          c.seekBy(-5_000);
          break;
        case "ArrowRight":
          c.seekBy(5_000);
          break;
        case "j":
        case "J":
          c.seekBy(-10_000);
          break;
        case "l":
        case "L":
          c.seekBy(10_000);
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
          update({ panel: true, tab: "transcript" });
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

/** True once `on` has held for `ms` without a break; false again as soon as it breaks. */
function useHeldFor(on: boolean, ms: number): boolean {
  const [over, setOver] = useState(false);
  if (!on && over) setOver(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setOver(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && over;
}

/**
 * The tracks to keep subscribed: the wanted ones and those let go less than LINGER_MS ago (tracks.ts), re-read when
 * the next one is due to go.
 */
function useLingered(wanted: Set<string>): Set<string> {
  const [linger] = useState(() => new Linger());
  const [held, setHeld] = useState(() => new Set(wanted));
  const key = [...wanted].sort().join("\n");
  useEffect(() => {
    const want = new Set(key ? key.split("\n") : []);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      const { held: now, next } = linger.hold(want, Date.now());
      setHeld((prev) => (prev.size === now.size && [...now].every((id) => prev.has(id)) ? prev : now));
      if (next !== undefined) timer = setTimeout(run, Math.max(0, next - Date.now()) + 10);
    };
    timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }, [linger, key]);
  return held;
}

/** Sound → Speaker and slide descriptions: each new slide's description, live, read aloud in the browser's voice. */
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

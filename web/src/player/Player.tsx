import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Loading } from "../brand/states";
import { prewarmValidators } from "../contracts/validate";
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
import { Controls } from "./Controls";
import { Discussion } from "./Discussion";
import { FrameClock } from "./frameClock";
import { languageOption } from "./languages";
import { LanguageOffer } from "./LanguageOffer";
import { Listening, useListening, useRoomService } from "./listening";
import { MediaUIEvents } from "./mediaChrome";
import { useNotes } from "./notes";
import "./player.css";
import { type PanelTab, type Prefs, type SourceKind, usePrefs } from "./prefs";
import type { RoomMediaElement, SubtitleChoice } from "./roomMediaElement";
import { ScreenMedia } from "./screenMedia";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { SidePanel } from "./SidePanel";
import type { SlideTracks } from "./slideTracks";
import { sourceShown, Stage } from "./Stage";
import { isTyping, TYPING_HOTKEYS } from "./typing";
import { forcedInput, playerState, type PlayerStateKind } from "./state";
import { guardOf } from "../package/download";
import {
  Linger,
  type RoomTracks,
  roomSubtitles,
  roomTracks,
  openTab as shownTab,
  wantedSlideTracks,
  wantedTracks,
} from "./tracks";

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
   * Why this room's listener tools are off (a looped demo room, whose room service takes chat only): the Discussion
   * tab says so in place of the discussion, and the annotation tools stay hidden, even with the service open.
   */
  noRoomService?: string;
  /** A demo room, a live session of a recorded lecture (decision 0032): its live state says so. */
  looped?: boolean;
  /**
   * A recording (`<id>-recording`, decision 0032): it opens at 0:00 and plays like video on demand; nothing live
   * (chat, the room service's tools) is offered, since nobody is in the room.
   */
  vod?: boolean;
}

const noop = () => () => {};
const zero = () => 0;

/** A connected relay that shows nothing of a room for this long means there is no such room. */
const UNKNOWN_AFTER_MS = 6_000;

/** A room with signs of life (announced, listed) that still sends nothing to play after this long is not answering. */
const STALLED_AFTER_MS = 15_000;

/** A connected relay has announced the room's slides by now, if it has any (the first announcements come at once). */
const SOURCES_WAIT_MS = 1_500;

/** Media Chrome's own hotkeys, bar Shift+/ (its shortcuts dialog: ours answers "?"). */
const HOTKEYS = "noshift+/";

/** The keys Media Chrome answers to (media-controller): forwarded to it from anywhere on the page. */
const MEDIA_KEYS = new Set([
  " ",
  "k",
  "m",
  "f",
  "c",
  "j",
  "l",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "<",
  ">",
]);

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
  const [saved, save] = usePrefs();
  // A subtitle language picked here belongs to this room: elsewhere a paid one is only offered (roomSubtitles).
  const update = useCallback(
    (change: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)) =>
      save((p) => {
        const c = typeof change === "function" ? change(p) : change;
        return "subtitleLang" in c ? { ...c, subtitleRoom: room } : c;
      }),
    [save, room],
  );
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
  const controller = useRef<HTMLElement>(null);
  const [el, setEl] = useState<RoomMediaElement | null>(null);
  const bindEl = useCallback((node: HTMLElement | null) => setEl(node as RoomMediaElement | null), []);
  // Compile the track validators in idle moments before the room's first objects need them.
  useEffect(() => prewarmValidators(), []);
  const [fullscreen, setFullscreen] = useState(false);
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
  // The catalog (whether a translation is running or free here) changes with the view, which re-renders.
  const carriesOver = roomSubtitles(saved, room, tracks, guardOf({ media, transport, roomName: room })) === saved;
  const prefs = useMemo<Prefs>(
    () => (carriesOver ? saved : { ...saved, subtitleLang: "original" }),
    [saved, carriesOver],
  );
  const carried = carriesOver ? undefined : saved.subtitleLang;
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
  // What the room sends is known from the page, the room catalog's sources or the slides' announcement; a room that
  // says nothing (a looped room's catalog lists no sources, and a room with no slides announces none) is taken as it
  // is shortly after the relay connects.
  const sourcesTold =
    props.sources !== undefined ||
    media === undefined ||
    media.catalog()?.tt.sources !== undefined ||
    status?.slidesLive === true;
  const sourcesWaited = useHeldFor(status?.status === "connected", SOURCES_WAIT_MS);
  const sourcesPending = !sourcesTold && !sourcesWaited;

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

  // Full screen takes the whole player, side panel included: Media Chrome's fullscreen element is the player.
  const hasView = view !== undefined;
  useEffect(() => {
    const c = controller.current as (HTMLElement & { fullscreenElement?: HTMLElement }) | null;
    if (c && root.current) c.fullscreenElement = root.current;
    const onChange = () => setFullscreen(document.fullscreenElement === root.current && root.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [hasView]);
  const toggleFullscreen = useCallback(() => {
    const type = document.fullscreenElement
      ? MediaUIEvents.MEDIA_EXIT_FULLSCREEN_REQUEST
      : MediaUIEvents.MEDIA_ENTER_FULLSCREEN_REQUEST;
    el?.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true }));
  }, [el]);

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
  // Nothing of the room on a connected relay for a while: no speaker broadcast or slides, no room catalog, room state
  // or archive. A room created but not started has its `waiting` record from the room service, so it reads "Not
  // started". Agents announcing are not the room (they can answer for any name), nor is the room service's `no-room`
  // answer (the listener socket then waits, which is not the room). The talk's title and speaker come from the same
  // room track as roomNow, and roomInfo() is always an object, so it is no sign of the room.
  const nothing =
    status?.status === "connected" &&
    !status.teacherLive &&
    !status.slidesLive &&
    roomNow === undefined &&
    media?.catalog() === undefined &&
    timeline?.liveEdge === undefined;
  const unknown = useHeldFor(nothing, UNKNOWN_AFTER_MS);
  const known = unknown ? false : status?.status === "connected" && !nothing ? true : undefined;
  const sessions = media?.hasSessions() ?? false;
  const looking =
    status?.status === "connected" &&
    known !== false &&
    roomNow === undefined &&
    onAir !== true &&
    timeline?.liveEdge === undefined;
  const stalled = useHeldFor(looking, STALLED_AFTER_MS);
  // A recording opens at its start (it is video on demand): once its span is known the playhead moves there, once.
  const vod = props.vod ?? false;
  const [vodStarted, setVodStarted] = useState(false);
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
    known,
    roomName: room,
    sessions,
    sessionEnded: view?.sessionEnded ?? false,
    vod,
    vodOpening: vod && !vodStarted,
    stalled,
  } as const;
  const state = playerState({ ...real, ...(forceState ? forcedInput(forceState) : {}) });
  const origin = media?.talkOrigin() ?? 0;

  // The media element: Media Chrome drives it; it holds the paused state and the playhead (held while paused live).
  const elementAt = el?.playback === playback ? el.roomTime() : undefined;
  const at = timeline
    ? (elementAt ?? (timeline.mode === "live" ? (timeline.position ?? timeline.liveEdge) : timeline.position))
    : undefined;

  const talkClock = (ms: number) => formatClock(media ? media.talkTime(ms) : ms);

  // Bind the element to this playback (a new demo session hands a new one, which carries on playing).
  useEffect(() => {
    const e = el;
    if (!e) return;
    e.bind(playback);
    const onPlayState = () => setUi({ playing: !e.paused });
    const onSubtitles = (ev: Event) => {
      const id = (ev as CustomEvent<string | null>).detail;
      update(id === null ? { cc: false } : { cc: true, subtitleLang: id });
    };
    const onVolume = (ev: Event) => {
      const { volume, muted } = (ev as CustomEvent<{ volume: number; muted: boolean }>).detail;
      update({ volume, muted });
    };
    e.addEventListener("play", onPlayState);
    e.addEventListener("pause", onPlayState);
    e.addEventListener("ttsubtitles", onSubtitles);
    e.addEventListener("ttvolume", onVolume);
    // Media Chrome fades the controls only for a pointer resting on the media element itself, not on what it holds
    // (the stage): a move over the stage is handed on as the element's own, a frame later (once the original has
    // reached the controller, which would otherwise cancel the fade it schedules), at most once a frame.
    let frame = 0;
    const onPointer = (ev: PointerEvent) => {
      if (!ev.isTrusted || ev.target === e || frame) return;
      const { pointerType, clientX, clientY } = ev;
      frame = requestAnimationFrame(() => {
        frame = 0;
        e.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType, clientX, clientY }));
      });
    };
    e.addEventListener("pointermove", onPointer);
    onPlayState();
    return () => {
      e.removeEventListener("play", onPlayState);
      e.removeEventListener("pause", onPlayState);
      e.removeEventListener("ttsubtitles", onSubtitles);
      e.removeEventListener("ttvolume", onVolume);
      e.removeEventListener("pointermove", onPointer);
      cancelAnimationFrame(frame);
    };
  }, [el, playback, setUi, update]);
  // What the element tells Media Chrome: the talk's 00:00 and span, the subtitle choices, the chapters, the volume.
  const recording = state.kind === "ended" && !sessions ? state.recording : undefined;
  const choices = useMemo(() => subtitleChoices(tracks), [tracks]);
  const outlineChapters = tracks.outline?.enabled ? tracks.outline.outline?.chapters : undefined;
  useEffect(() => {
    const e = el;
    if (!e) return;
    e.setSpan({ origin, recording });
    e.setSubtitles(choices, prefs.cc ? showingChoice(prefs, choices) : undefined);
    const end = timeline?.liveEdge ?? timeline?.position ?? 0;
    e.setChapters(
      (outlineChapters ?? []).map((c, i, all) => ({
        startMs: c.start_ms,
        endMs: all[i + 1]?.start_ms ?? Math.max(end, c.start_ms),
        title: c.title,
      })),
    );
    e.setVolumeQuietly(prefs.volume, prefs.muted);
    e.setPipSource(() => {
      const tile = e.querySelector(".tt-tile-camera");
      return (
        tile?.querySelector<HTMLVideoElement>("video.tt-media:not(.tt-hidden)") ??
        tile?.querySelector<HTMLCanvasElement>("canvas.tt-media:not(.tt-hidden)") ??
        undefined
      );
    });
  });

  // A recording opens at its start: once the element plays this room and the recording's span is known, the playhead
  // moves to 0:00, once (it then plays like any rewind; the end card waits for the real end).
  const vodStart =
    vod && !vodStarted && state.kind === "ended" && timeline?.liveEdge !== undefined ? timeline.start : undefined;
  useEffect(() => {
    if (vodStart === undefined || !el || el.playback !== playback) return;
    seekRoom(el, origin, vodStart);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- records the seek just made on the element, once
    setVodStarted(true);
  }, [vodStart, el, playback, origin]);

  const togglePlay = useCallback(() => {
    const e = el;
    if (!e) return;
    if (e.paused) void e.play();
    else e.pause();
  }, [el]);

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
          carried,
          update,
          ui,
          setUi,
          state,
          clock,
          notes,
          sources,
          sourcesPending,
          slides,
          slidesShown,
          audienceShown,
          slideNumber,
          extraTabs,
          // Listener tools only while the room service can take writes (or is still connecting).
          listening: toolsOff ? undefined : listening,
          roomService,
          looped: props.looped ?? false,
          vod,
          at,
          talkClock,
          origin,
          element: () => el,
          seek: (ms) => seekRoom(el, origin, ms),
          seekBy: (ms) => {
            const from = el?.roomTime() ?? playback.liveEdge();
            if (from !== undefined) seekRoom(el, origin, from + ms);
          },
          goLive: () => el?.goLive(),
          openTab,
          holdTracks,
          togglePlay,
          addBookmark,
          announce,
        }
      : undefined;

  useShortcuts(ctx, controller);

  if (!ctx)
    return (
      <main id="main">
        <Loading className="tt-loading">Connecting…</Loading>
      </main>
    );

  return (
    <PlayerContext.Provider value={ctx}>
      <div
        ref={root}
        className={`tt-player${prefs.panel ? " tt-with-panel" : ""}${fullscreen ? " tt-fullscreen" : ""}`}
        data-state={state.kind}
      >
        {/* The skip link's target: the talk itself, its canvas and controls (the side panel beside). */}
        <main className="tt-main" id="main" tabIndex={-1}>
          <media-controller
            ref={controller}
            className="tt-controller"
            gesturesdisabled=""
            hotkeys={HOTKEYS}
            novolumepref=""
            nomutedpref=""
            nosubtitleslangpref=""
            defaultstreamtype="live"
            noautohide={ui.menu ? "" : undefined}
          >
            <tt-room-media ref={bindEl} slot="media" className="tt-media-element">
              <Stage onToggle={togglePlay} onFullscreen={toggleFullscreen} />
            </tt-room-media>
            <header slot="top-chrome" className="tt-titlebar">
              <Link href="/" className="tt-brand">
                Talk Tracks
              </Link>
              <div className="tt-title-block">
                <h1 className="tt-title">{title}</h1>
                {speaker || props.credit ? (
                  <span className="tt-credit">{[speaker, props.credit].filter(Boolean).join(" · ")}</span>
                ) : null}
              </div>
              <span className="tt-notices">
                {/* The room service has no such room either: the unknown-room card says so, not an outage. */}
                {serviceDown && state.kind !== "unknown" && state.kind !== "connecting" ? (
                  <span className="tt-notice tt-notice-degraded" role="status" title={toolsOff}>
                    Room service unreachable
                  </span>
                ) : null}
                {props.notice ? <span className="tt-notice">{props.notice}</span> : null}
              </span>
            </header>
            <media-loading-indicator slot="centered-chrome" className="tt-loading-indicator" loadingdelay="600" />
            <LanguageOffer />
            <Controls quality={false} />
          </media-controller>
        </main>
        {prefs.panel ? <SidePanel /> : null}
        {ui.shortcuts ? <ShortcutsDialog onClose={() => setUi({ shortcuts: false })} /> : null}
        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>
      </div>
    </PlayerContext.Provider>
  );
}

/** Seek the element to room ms `ms` (it speaks the talk clock's seconds). */
function seekRoom(e: RoomMediaElement | null, origin: number, ms: number): void {
  if (e) e.currentTime = Math.max(0, ms - origin) / 1000;
}

/** The subtitle choices as text tracks: the original, then every translation the room runs. */
function subtitleChoices(tracks: RoomTracks): SubtitleChoice[] {
  const out: SubtitleChoice[] = [];
  if (tracks.captions) {
    const lang = tracks.captions.lang ?? "en";
    out.push({ id: "original", label: `${languageOption(lang).autonym} (original)`, language: lang });
  }
  for (const t of tracks.translations) {
    const lang = t.lang!;
    const o = languageOption(lang);
    out.push({ id: lang, label: o.local !== o.autonym ? `${o.autonym} · ${o.local}` : o.autonym, language: lang });
  }
  return out;
}

/** The choice shown for the subtitle preference, if the room offers it. */
function showingChoice(prefs: Pick<Prefs, "subtitleLang">, choices: readonly SubtitleChoice[]): string | undefined {
  if (prefs.subtitleLang === "original") return choices.some((c) => c.id === "original") ? "original" : undefined;
  const base = (tag: string) => tag.toLowerCase().split("-")[0];
  return (
    choices.find((c) => c.id.toLowerCase() === prefs.subtitleLang.toLowerCase())?.id ??
    choices.find((c) => c.id !== "original" && base(c.id) === base(prefs.subtitleLang))?.id
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
  if (status === undefined || noService !== undefined) return noService;
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

/**
 * Keyboard shortcuts on the whole page (the player is the page). Media Chrome answers the media keys (Space and K,
 * J and L, the arrows, M, F, C, < and >) inside its controller; pressed anywhere else on the page they are handed to
 * it. The room's own keys are ours: G go live, S side panel, B bookmark, N note, / search, [ and ] subtitle size, ?
 * these shortcuts, I Stats for nerds.
 */
function useShortcuts(ctx: PlayerCtx | undefined, controller: RefObject<HTMLElement | null>): void {
  const latest = useRef(ctx);
  useEffect(() => {
    latest.current = ctx;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = latest.current;
      if (!c || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (isTyping(e)) {
        if (e.key === "Escape") c.setUi({ menu: undefined });
        return;
      }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const mc = controller.current as (HTMLElement & { keyboardShortcutHandler?(e: unknown): void }) | null;
      if (MEDIA_KEYS.has(key)) {
        // Inside the controller Media Chrome has it already; a focused button keeps Space for itself.
        if (!mc || (target && mc.contains(target))) return;
        if (key === " " && target?.closest("button, a, [role='button'], [role='tab'], [role='slider']")) return;
        mc.keyboardShortcutHandler?.({ key, target: mc, shiftKey: e.shiftKey });
        e.preventDefault();
        return;
      }
      const { prefs, update, setUi } = c;
      switch (key) {
        case "g":
          c.goLive();
          break;
        case "[":
        case "]": {
          const size = Math.min(44, Math.max(12, prefs.style.size + (key === "]" ? 2 : -2)));
          update({ style: { ...prefs.style, size } });
          c.announce(`Subtitle size ${size}`);
          break;
        }
        case "s":
          update({ panel: !prefs.panel });
          break;
        case "b":
          c.addBookmark();
          break;
        case "n":
          c.openTab("notes");
          setUi((u) => ({ focusNote: u.focusNote + 1 }));
          break;
        case "/":
          update({ panel: true, tab: "transcript" });
          setUi((u) => ({ focusSearch: u.focusSearch + 1 }));
          break;
        case "i":
          setUi((u) => ({ stats: !u.stats, menu: undefined }));
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
    // Media Chrome's controller answers keys bubbling through it with no regard for text fields: typing "k", "j"
    // or a space in the subtitle language search would pause or rewind the talk. Before it sees a key, switch its
    // hotkeys off while a field takes the keys, and back on for any other key.
    const guard = (e: KeyboardEvent) => {
      const mc = controller.current;
      if (!mc) return;
      const want = isTyping(e) ? TYPING_HOTKEYS : HOTKEYS;
      if (mc.getAttribute("hotkeys") !== want) mc.setAttribute("hotkeys", want);
    };
    window.addEventListener("keydown", guard, true);
    window.addEventListener("keyup", guard, true);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", guard, true);
      window.removeEventListener("keyup", guard, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [controller]);
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

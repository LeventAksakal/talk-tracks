import { Badge, Banner, Button, Switch, ToggleButton } from "@astryxdesign/core";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RoomService } from "../annotate/client";
import { AUDIO_TRACK, HANG_CATALOG_TRACK, teacherPath } from "../contracts/names";
import type { RoomCatalog } from "../contracts/types";
import { type HangClock, hangClockOfPayload } from "../playback/roomClock";
import type { HistorySource } from "../playback/source";
import { MoqHistorySource } from "../playback/moqSource";
import { watchRoomCatalog } from "../playback/roomCatalog";
import { Glyph, type GlyphName } from "../brand/Glyph";
import { LogoMark } from "../brand/LogoMark";
import { Modal, ModalBody, ModalFooter } from "../brand/Modal";
import { Link, navigate } from "../router";
import { useResource } from "../useResource";
import { MoqTransport } from "../transport/moq";
import type { ConnectionStatus, Transport } from "../transport/types";
import { Audience, features } from "./Audience";
import { type ClockState, clockState, roomNowFn, wallNowMs } from "./clock";
import type { Deck, RenderedSlide } from "./deck";
import { type Echo, watchEcho } from "./echo";
import { type EndOutcome, endRoomOnce, untilAnswered } from "./endRoom";
import { AudienceLink, ProjectInvite, QrCode, shortUrl, useCopy, watchUrl } from "./Invite";
import { type Tool, isShapeTool, keyAction } from "./keys";
import type { MediaSnapshot, SpeakerMedia } from "./media";
import { LevelMeter, ScreenPreview, SelfView, useLevel } from "./MediaViews";
import { FRESH_AUDIO_MS, isOwnAudio, onAirState, type OnAir } from "./onair";
import { SlidesPublisher } from "./publisher";
import { SLIDE_ACCEPT } from "./slideFiles";
import { SlidesSetup, useSlideDeck } from "./SlidesSetup";
import { Questions, useQuestionCounts } from "./Questions";
import { titleOf } from "./talkTitle";
import { type BroadcastSink, lazyBroadcast } from "./sink";
import { Stage, type ToolColors, type WidthStep, colorKey } from "./Stage";
import { type TokenCheck, checkToken } from "./token";
import { PasteSpeakerLink } from "../pages/CreateTalk";
import { CHALK_BOX, type InkName, inkColor } from "../theme/ink";
import { Icon } from "../player/icons";
import "./console.css";

/** What the console runs on; TalkPage gives it the relay, tests give it memory. */
export interface ConsoleDeps {
  /** Where the audience area reads the chat from; by default the watcher's connection, when it is a relay's. */
  chatSource?: HistorySource;
  /** The relay connection that carries the token: status for pre-flight. */
  publisherStatus?: Pick<Transport, "status" | "onStatus">;
  /** An anonymous connection (a viewer's view of the relay): the catalog and the proofs of publishing. */
  watcher: Transport;
  /** The slides broadcast, talk/<room>/slides. */
  makeSink: () => BroadcastSink;
  /** How chosen files become a deck (slideFiles.openSlides: PDF, PowerPoint, pictures). */
  openDeck: (files: readonly File[]) => Promise<Deck>;
  /** Microphone and camera; absent where there are no devices (tests). */
  createMedia?: () => Promise<SpeakerMedia>;
  /** Development without a room service: E chosen locally, slides go out at once. */
  localEpochMs?: number;
  /** The room service's endpoint as the speaker (decision 0024): the audience's questions, reply and hide. */
  makeRoomService?: (name: string) => RoomService;
  /**
   * Tell the room service the talk ended (its state says "ended"), one try: true or `acked` once it acknowledged.
   * Default: `endRoomOnce` when there is a room service. End talk tries again until the service answers.
   */
  endRoom?: () => Promise<boolean | EndOutcome>;
  /** The pause before End talk's second try, ms (it doubles, up to 10 s); default 1 s. */
  endRetryMs?: number;
  /** The talk's end is settled at the room service (or there is none): the speaker link is no longer kept. */
  onEnded?: () => void;
  /**
   * The relay refuses a broadcast without a valid speaker token (the public relay, `relayNeedsToken`): Go on air
   * waits for one. Default false: a local relay, and tests.
   */
  tokenRequired?: boolean;
}

/** End talk at the room service: being said, said (or nothing to end), or refused. */
type Ending = "ending" | "ended" | "refused";

type Phase = "preflight" | "on-air" | "paused" | "ended";

const NAME_KEY = "tt.speaker.name";
const loadName = () => {
  try {
    return localStorage.getItem(NAME_KEY) || "Speaker";
  } catch {
    return "Speaker";
  }
};

/**
 * The drawing tools in their groups (pointing and freehand, shapes, text marks), drawn as icons in the stage's tool
 * rail; the name and key show in the tooltip. `name` is the accessible name when the short label leaves out what it
 * acts on.
 */
const TOOLS: { tool: Tool; label: string; key: string; icon: GlyphName; name?: string }[][] = [
  [
    { tool: "laser", label: "Laser", key: "L", icon: "pointScan", name: "Laser pointer" },
    { tool: "pen", label: "Pen", key: "D", icon: "stylus" },
    { tool: "highlighter", label: "Highlighter", key: "H", icon: "inkHighlighter" },
  ],
  [
    { tool: "rect", label: "Rectangle", key: "R", icon: "cropSquare" },
    { tool: "ellipse", label: "Ellipse", key: "O", icon: "circle" },
    { tool: "arrow", label: "Arrow", key: "A", icon: "arrowOutward" },
    { tool: "line", label: "Line", key: "I", icon: "horizontalRule" },
    { tool: "diamond", label: "Diamond", key: "G", icon: "diamond" },
  ],
  [
    { tool: "underline", label: "Underline", key: "U", icon: "formatUnderlined", name: "Underline text" },
    { tool: "highlight", label: "Mark text", key: "M", icon: "formatInkHighlighter" },
    { tool: "eraser", label: "Eraser", key: "E", icon: "inkEraser" },
  ],
];

const WIDTH_NAMES: Record<WidthStep, string> = { 0: "Thin", 1: "Medium", 2: "Bold" };
const hasWidth = (t: Tool) => t === "pen" || t === "highlighter" || isShapeTool(t);
const hasOptions = (t: Tool) => colorKey(t) !== undefined || hasWidth(t);

/** The chalk box per tool (brand.md §3): every chalk for ink and shapes, the bright ones for the marker and marks. */
const SWATCHES: Record<keyof ToolColors, InkName[]> = {
  pen: CHALK_BOX.map((i) => i.name),
  highlighter: ["sun", "mint", "rose", "sky"],
  shape: CHALK_BOX.map((i) => i.name),
  underline: ["coral", "sky", "mint", "sun"],
  highlight: ["sun", "mint", "rose", "sky"],
};

const clockText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
};

export function Console({ room, token, deps }: { room: string; token: string | undefined; deps: ConsoleDeps }) {
  // Made in an effect (StrictMode mounts twice): one slides broadcast per console, ended on unmount.
  const publisher = useResource(
    () => new SlidesPublisher(lazyBroadcast(deps.makeSink), { id: "speaker", name: loadName(), speaker: true }),
    [deps],
  );
  if (!publisher) return null;
  return <ConsoleView key={publisher.tag} room={room} token={token} deps={deps} publisher={publisher} />;
}

function ConsoleView({
  room,
  token,
  deps,
  publisher,
}: {
  room: string;
  token: string | undefined;
  deps: ConsoleDeps;
  publisher: SlidesPublisher;
}) {
  const { watcher } = deps;
  // The audience area's chat reads talk/<room>/chat through the viewer's connection (deps.chatSource in tests).
  const chatSource = useMemo(
    () => deps.chatSource ?? (watcher instanceof MoqTransport ? new MoqHistorySource(watcher) : undefined),
    [deps.chatSource, watcher],
  );
  const [phase, setPhase] = useState<Phase>("preflight");
  const [name, setName] = useState(loadName);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  // --- the relay connection ------------------------------------------------------------------------
  const [connection, setConnection] = useState<{ status: ConnectionStatus; error?: string }>(() => ({
    status: deps.publisherStatus?.status() ?? "connected",
  }));
  useEffect(() => {
    const sub = deps.publisherStatus?.onStatus((status, error) => setConnection({ status, error: error?.message }));
    return () => sub?.close();
  }, [deps.publisherStatus]);
  const tokenCheck = checkToken(token, room, now);
  const tokenRequired = deps.tokenRequired ?? false;
  const canPublish = !tokenRequired || tokenCheck.kind === "ok";

  // --- microphone and camera -----------------------------------------------------------------------
  const [media, setMedia] = useState<SpeakerMedia>();
  const [snap, setSnap] = useState<MediaSnapshot>();
  const [mediaError, setMediaError] = useState<string>();
  useEffect(() => {
    if (!deps.createMedia) return;
    let closed = false;
    let made: SpeakerMedia | undefined;
    let off: (() => void) | undefined;
    deps
      .createMedia()
      .then((m) => {
        if (closed) return m.close();
        made = m;
        off = m.onChange(setSnap);
        setMedia(m);
        setSnap(m.snapshot());
      })
      .catch((e: unknown) => setMediaError(e instanceof Error ? e.message : String(e)));
    return () => {
      closed = true;
      off?.();
      made?.close();
    };
  }, [deps]);
  const level = useLevel(snap?.micTrack);
  // Once this microphone has been heard it stays heard: speech has pauses.
  const [heard, setHeard] = useState<MediaStreamTrack>();
  if (snap?.micTrack && level > 0.25 && heard !== snap.micTrack) setHeard(snap.micTrack);
  const micHeard = !!snap?.micTrack && heard === snap.micTrack;
  const [withAudio, setWithAudio] = useState(false);
  // On air, one side panel at a time (Meet's people and chat): the audience, or their questions.
  const [panel, setPanel] = useState<"slides" | "audience" | "questions">();

  // --- on air: the relay must carry our own audio back (a refused publish is silent) ---------------
  const mediaOnAir = snap?.onAir ?? false;
  const ownAudioAt = useRef<number | undefined>(undefined);
  const otherAudioAt = useRef<number | undefined>(undefined);
  const [audioSeen, setAudioSeen] = useState<{ own?: number; other?: number }>({});
  const [startedAt, setStartedAt] = useState(0);
  // When the broadcast last went up: on-air proof is timed from here (a resume needs it again).
  const [resumedAt, setResumedAt] = useState(0);
  useEffect(() => {
    if (!mediaOnAir) return;
    ownAudioAt.current = undefined;
    otherAudioAt.current = undefined;
    const sub = watcher.subscribe(
      teacherPath(room),
      AUDIO_TRACK,
      ({ payload, receivedAt }) => {
        if (isOwnAudio(payload, performance.now())) ownAudioAt.current = receivedAt;
        else otherAudioAt.current = receivedAt;
      },
      { maxAgeMs: 0 },
    );
    const t = setInterval(() => setAudioSeen({ own: ownAudioAt.current, other: otherAudioAt.current }), 1_000);
    return () => {
      sub.close();
      clearInterval(t);
    };
  }, [watcher, room, mediaOnAir]);
  const onAir: OnAir =
    phase !== "on-air"
      ? { kind: "off" }
      : onAirState({
          mic: !snap ? "starting" : snap.micError ? "error" : snap.micOn ? "publishing" : "off",
          micError: snap?.micError,
          publisherStatus: connection.status,
          publisherError: connection.error,
          ownAudioAgoMs: audioSeen.own === undefined ? undefined : now - audioSeen.own,
          otherSpeaker: audioSeen.other !== undefined && now - audioSeen.other < FRESH_AUDIO_MS,
          elapsedMs: now - resumedAt,
        });

  // --- the room clock ------------------------------------------------------------------------------
  const [catalog, setCatalog] = useState<RoomCatalog>();
  useEffect(() => {
    const sub = watchRoomCatalog(watcher, room, setCatalog);
    return () => sub.close();
  }, [watcher, room]);
  const [hang, setHang] = useState<HangClock | null>();
  useEffect(() => {
    if (!mediaOnAir) return;
    const sub = watcher.subscribe(teacherPath(room), HANG_CATALOG_TRACK, ({ payload }) =>
      setHang(hangClockOfPayload(payload) ?? null),
    );
    return () => {
      sub.close();
      setHang(undefined);
    };
  }, [watcher, room, mediaOnAir]);
  const clock = clockState(mediaOnAir, hang, catalog, deps.localEpochMs);
  const [live, setLive] = useState(false);
  const hangRef = useRef(hang);
  useLayoutEffect(() => {
    hangRef.current = hang;
  });
  useEffect(() => {
    if (clock.kind !== "ready" || publisher.live || phase === "ended") return;
    const roomNow = roomNowFn(clock, hangRef.current);
    if (!roomNow) return;
    publisher.goLive(roomNow);
    setLive(true);
  }, [clock, publisher, phase]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => publisher.tick(), 100);
    return () => clearInterval(t);
  }, [live, publisher]);
  const [echo, setEcho] = useState<Echo>();
  useEffect(() => {
    if (!live) return;
    const sub = watchEcho(watcher, room, setEcho);
    return () => sub.close();
  }, [live, watcher, room]);

  // --- the deck: SlidesSetup's state (slide-upload lane), shared by the green room, the stage and the keys ---------
  const fileInput = useRef<HTMLInputElement>(null);

  // --- the audience's questions (decision 0024): the console's session at the room service is the speaker's -----
  const roomService = useResource(() => deps.makeRoomService?.(loadName()), [deps]);
  useEffect(() => {
    if (roomService && name.trim()) roomService.setName(name);
  }, [roomService, name]);
  const questionCounts = useQuestionCounts(roomService, publisher.deckId);

  const sendFrame = useCallback(
    (s: RenderedSlide | undefined) => {
      if (s && publisher.live)
        publisher.publishFrame({ at_ms: Math.round(wallNowMs(hangRef.current ?? undefined)), ...s.frame });
    },
    [publisher],
  );

  const slideDeck = useSlideDeck({ publisher, openDeck: deps.openDeck, onShown: sendFrame });
  const { deck, index, hidden, goTo } = slideDeck;
  const toggleBlank = slideDeck.toggleHidden;
  const loadFiles = (files: FileList | null | undefined) => void slideDeck.add(files ? Array.from(files) : []);

  // Once live, the describe agent gets the slide on screen.
  useEffect(() => {
    if (live) sendFrame(slideDeck.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on going live
  }, [live]);

  // --- tools ---------------------------------------------------------------------------------------
  const [tool, setTool] = useState<Tool>("none");
  const [colors, setColors] = useState<ToolColors>({
    pen: inkColor("coral"),
    highlighter: inkColor("sun"),
    shape: inkColor("sky"),
    underline: inkColor("coral"),
    highlight: inkColor("sun"),
  });
  const [width, setWidth] = useState<WidthStep>(1);
  const stepWidth = (step: -1 | 1) => setWidth((w) => Math.min(2, Math.max(0, w + step)) as WidthStep);
  const history = useSyncExternalStore(
    (fn) => publisher.onChange(fn),
    () => `${publisher.canUndo() ? "u" : ""}${publisher.canRedo() ? "r" : ""}`,
  );
  const colorTool = colorKey(tool);
  // A tool's colour and width open in a popover from the tool when it is picked, and close when you draw.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const pickTool = (t: Tool) => {
    if (t !== "laser") publisher.pointerOff();
    setOptionsOpen(tool !== t && hasOptions(t));
    setTool((current) => (current === t ? "none" : t));
  };

  // --- keys and clickers ---------------------------------------------------------------------------
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useLayoutEffect(() => {
    keyHandler.current = (e: KeyboardEvent) => {
      if (phase === "ended") return;
      const a = keyAction(e);
      if (!a) return;
      e.preventDefault();
      if (a.kind === "next") void goTo(index + 1);
      else if (a.kind === "prev") void goTo(index - 1);
      else if (a.kind === "first") void goTo(0);
      else if (a.kind === "last" && deck) void goTo(deck.count - 1);
      else if (a.kind === "blank") toggleBlank();
      else if (a.kind === "undo") publisher.undo();
      else if (a.kind === "redo") publisher.redo();
      else if (a.kind === "width") stepWidth(a.step);
      else if (a.kind === "tool") {
        if (a.tool !== "laser") publisher.pointerOff();
        setOptionsOpen(hasOptions(a.tool));
        setTool(a.tool);
      }
    };
  });
  useEffect(() => {
    const fn = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  // --- go on air, end ------------------------------------------------------------------------------
  const goOnAir = () => {
    if (!media) return;
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // not kept: the name still goes out this time
    }
    publisher.setAuthorName(name.trim().slice(0, 60) || "Speaker");
    if (!snap?.micOn) media.setMic(true);
    media.goOnAir();
    setStartedAt(Date.now());
    setResumedAt(Date.now());
    setPhase("on-air");
  };
  // Pause withdraws the broadcast (the room says "Paused" to viewers) and keeps the devices, slides and drawing;
  // Resume puts it back on the same room clock.
  const pause = () => {
    media?.goOffAir();
    publisher.pointerOff();
    setPhase("paused");
  };
  const resume = () => {
    if (!media) return;
    media.goOnAir();
    setResumedAt(Date.now());
    setPhase("on-air");
  };
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [endedAt, setEndedAt] = useState(0);
  const [savedTitle] = useState(() => titleOf(room));
  const talkTitle = savedTitle ?? deck?.title ?? undefined;
  const [ending, setEnding] = useState<Ending>("ended");
  // Stops End talk's retries when the console goes away.
  const endAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => endAbort.current?.abort(), []);
  const sayEnded = () => {
    const end = deps.endRoom ?? (deps.makeRoomService ? () => endRoomOnce(room, token ?? "local") : undefined);
    if (!end) {
      setEnding("ended");
      deps.onEnded?.();
      return;
    }
    endAbort.current?.abort();
    const abort = (endAbort.current = new AbortController());
    setEnding("ending");
    // A lost message or a socket that is down is tried again until the room service answers.
    void untilAnswered(end, { firstDelayMs: deps.endRetryMs, signal: abort.signal }).then((outcome) => {
      if (abort.signal.aborted) return;
      setEnding(outcome === "refused" ? "refused" : "ended");
      deps.onEnded?.();
    });
  };
  const endTalk = () => {
    // Said first, so the room service hears "ended" before it sees the broadcast go.
    sayEnded();
    publisher.pointerOff();
    publisher.stop();
    media?.close();
    setMedia(undefined);
    setSnap(undefined);
    setConfirmEnd(false);
    setLive(false);
    setEndedAt(Date.now());
    setPhase("ended");
  };

  if (phase === "ended")
    return (
      <Ended
        room={room}
        title={talkTitle}
        now={now}
        ending={ending}
        retry={sayEnded}
        onAirMs={endedAt - startedAt}
        slideCount={deck?.count ?? 0}
        still={slideDeck.current?.url ?? slideDeck.thumbs[0]}
        made={features(catalog, now).map((f) => f.name)}
      />
    );

  const current = slideDeck.current;
  const aspect = deck?.aspect ?? 16 / 9;
  const slideLabel = deck ? `Slide ${index + 1} of ${deck.count}${hidden ? ", hidden from viewers" : ""}` : "No slides";
  const sharing = !!snap?.screenTrack;
  const frameAspect = sharing ? 16 / 9 : aspect;
  const openQuestions = [...questionCounts.values()].reduce((a, b) => a + b, 0);
  const micState = snap?.micError ? "bad" : snap?.micOn ? (micHeard ? "ok" : "wait") : "off";
  const goLabel = !canPublish
    ? "Needs your speaker link: paste it above"
    : mediaError
      ? `The microphone and camera could not load: ${mediaError}`
      : !media
        ? "Waiting for the microphone and camera to load"
        : undefined;

  return (
    <div className="console" data-phase={phase}>
      <ConsoleHeader room={room} title={talkTitle} now={now}>
        <OnAirBadge onAir={onAir} paused={phase === "paused"} elapsed={phase !== "preflight" ? now - startedAt : 0} />
      </ConsoleHeader>
      <Modal
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title="End the talk?"
        titleId="end-heading"
        size="sm"
        role="alertdialog"
      >
        <ModalBody>
          <p className="end-confirm">
            Viewers see that the talk ended, and nothing more goes out. The recording, the slides and everything drawn
            on them stay replayable.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button label="Keep talking" variant="secondary" onClick={() => setConfirmEnd(false)} />
          <Button label="End talk" variant="destructive" onClick={endTalk} />
        </ModalFooter>
      </Modal>
      <div className="console-alerts">
        {onAir.kind === "refused" || onAir.kind === "error" ? (
          <Banner status="warning" title="Not on air" description={onAir.reason} role="alert" />
        ) : null}
        {connection.status === "disconnected" && phase === "on-air" ? (
          <Banner
            status="warning"
            title="Connection dropped"
            description="Reconnecting. Keep talking: the console sends again as soon as it is back."
            role="alert"
          />
        ) : null}
      </div>

      <div className="console-body">
        <main
          id="main"
          className="console-main"
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            loadFiles(e.dataTransfer.files);
          }}
        >
          <div className="stage-head">
            <h2 className="stage-caption">
              {phase === "preflight" ? "Preview: what viewers will see" : "What viewers see"}
            </h2>
            <span className="stage-wire" data-testid="wire-status">
              <WireStatus live={live} clock={clock} echo={echo} phase={phase} />
            </span>
          </div>
          <div className="stage-row">
            {/* The drawing tools come with a deck, as a rail on the stage's left edge (Excalidraw's, tldraw's): before
                one is loaded the stage asks for it, and a rail of disabled tools would only say the console is half
                built. Undo, redo and clear close the rail: they act on the drawing. */}
            {deck && !sharing ? (
              <div className="tool-rail" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
                {TOOLS.map((group, i) => (
                  <div key={i} className="rail-group">
                    {group.map((t) => {
                      const options = tool === t.tool && hasOptions(t.tool);
                      return (
                        <span key={t.tool} className="tool-slot">
                          <ToggleButton
                            label={`${t.name ?? t.label} (${t.key})`}
                            isIconOnly
                            icon={<Glyph name={t.icon} />}
                            isPressed={tool === t.tool}
                            onPressedChange={() => pickTool(t.tool)}
                          />
                          {options ? (
                            <button
                              type="button"
                              className="tool-options-toggle"
                              aria-label={`${t.label} colour and width`}
                              aria-expanded={optionsOpen}
                              title="Colour and width"
                              onClick={() => setOptionsOpen((o) => !o)}
                            >
                              <span
                                className="tool-options-dot"
                                style={colorTool ? { background: colors[colorTool] } : undefined}
                              />
                            </button>
                          ) : null}
                          {options && optionsOpen ? (
                            <div className="tool-popover" role="group" aria-label={`${t.label} options`}>
                              {colorTool ? (
                                <Swatches
                                  tool={colorTool}
                                  value={colors[colorTool]}
                                  onChange={(c) => setColors((prev) => ({ ...prev, [colorTool]: c }))}
                                />
                              ) : null}
                              {hasWidth(tool) ? <Widths value={width} onChange={setWidth} /> : null}
                              <span className="tool-popover-hint">Closes when you draw</span>
                            </div>
                          ) : null}
                        </span>
                      );
                    })}
                  </div>
                ))}
                <div className="rail-group" role="group" aria-label="Drawing on this slide">
                  <Button
                    label="Undo"
                    tooltip="Undo (Ctrl+Z)"
                    isIconOnly
                    variant="ghost"
                    icon={<Glyph name="undo" />}
                    isDisabled={hidden || !history.includes("u")}
                    onClick={() => publisher.undo()}
                  />
                  <Button
                    label="Redo"
                    tooltip="Redo (Ctrl+Y)"
                    isIconOnly
                    variant="ghost"
                    icon={<Glyph name="redo" />}
                    isDisabled={hidden || !history.includes("r")}
                    onClick={() => publisher.redo()}
                  />
                  <Button
                    label="Clear slide"
                    tooltip="Clear this slide's drawing"
                    isIconOnly
                    variant="ghost"
                    icon={<Glyph name="deleteSweep" />}
                    isDisabled={hidden}
                    onClick={() => publisher.clearSlide()}
                  />
                </div>
              </div>
            ) : null}
            <div className="stage-area" onPointerDownCapture={() => setOptionsOpen(false)}>
              <div className="stage-frame" style={{ "--aspect": String(frameAspect) } as CSSProperties}>
                {sharing ? (
                  // While a screen is shared, viewers see it in place of the slides (the camera stays in the corner).
                  <ScreenPreview track={snap?.screenTrack} className="stage stage-screen" />
                ) : deck ? (
                  <Stage
                    publisher={publisher}
                    slide={current}
                    aspect={aspect}
                    tool={tool}
                    colors={colors}
                    width={width}
                    hidden={hidden}
                    label={slideLabel}
                  />
                ) : (
                  <EmptyStage camera={snap?.cameraTrack} name={name} busy={!!slideDeck.busy} />
                )}
                {sharing || deck ? <SelfView track={snap?.cameraTrack} className="stage-camera" /> : null}
              </div>
            </div>
          </div>
          {/* Before air the slide pager sits under the preview; on air it moves into the dock. */}
          {deck && phase === "preflight" ? (
            <div className="stage-foot">
              <SlidePager index={index} count={deck.count} goTo={goTo} />
            </div>
          ) : null}
        </main>

        {phase === "preflight" ? (
          <aside className="green-room" aria-labelledby="ready-heading">
            <div className="green-head">
              <h2 id="ready-heading">Ready to go on air?</h2>
              <p className="green-sub">{readiness(snap, micHeard, !!deck, canPublish)}</p>
            </div>
            <ul className="setup-list">
              <SetupRow
                state={micState}
                control={
                  <RoundButton
                    icon={snap?.micOn ? "mic" : "micOff"}
                    label="Microphone"
                    pressed={snap?.micOn ?? false}
                    disabled={!media}
                    onClick={() => media?.setMic(!snap?.micOn)}
                  />
                }
                title="Microphone"
                detail={
                  <DevicePicker
                    label="Microphone"
                    devices={snap?.micDevices ?? []}
                    value={snap?.micDevice}
                    onChange={(id) => media?.chooseMic(id)}
                    fallback={
                      snap?.micError ?? (snap?.micOn ? "Say something: the bar moves" : "Off. Going on air turns it on")
                    }
                  />
                }
              >
                <LevelMeter level={level} label="Microphone level" />
              </SetupRow>
              <SetupRow
                state={snap?.cameraError ? "bad" : snap?.cameraOn ? (snap.cameraTrack ? "ok" : "wait") : "off"}
                control={
                  <RoundButton
                    icon={snap?.cameraOn ? "videocam" : "videocamOff"}
                    label="Camera"
                    pressed={snap?.cameraOn ?? false}
                    disabled={!media}
                    onClick={() => media?.setCamera(!snap?.cameraOn)}
                  />
                }
                title="Camera"
                detail={
                  <DevicePicker
                    label="Camera"
                    devices={snap?.cameraDevices ?? []}
                    value={snap?.cameraDevice}
                    onChange={(id) => media?.chooseCamera(id)}
                    fallback={snap?.cameraError ?? (snap?.cameraOn ? "Viewers see you beside the slides" : "Optional")}
                  />
                }
              />
              <SetupRow
                state={snap?.screenError ? "bad" : sharing ? "ok" : snap?.screenStarting ? "wait" : "off"}
                control={
                  <RoundButton
                    icon={sharing ? "cancelPresentation" : "presentToAll"}
                    label={sharing ? "Stop sharing" : "Share screen"}
                    pressed={sharing}
                    disabled={!media?.shareScreen || (!sharing && !!snap?.screenStarting)}
                    onClick={() => (sharing ? media?.stopScreen?.() : void media?.shareScreen?.(withAudio))}
                  />
                }
                title="Screen"
                detail={
                  snap?.screenError ??
                  (sharing
                    ? `Shown in place of the slides${snap?.screenAudio ? ", with its sound" : ""}`
                    : snap?.screenStarting
                      ? "Pick what to share in your browser's window"
                      : "Optional: a demo or code")
                }
              >
                <Switch
                  label="With its sound"
                  value={withAudio}
                  isDisabled={!media?.shareScreen || sharing || snap?.screenStarting}
                  onChange={setWithAudio}
                />
              </SetupRow>
              {/* The slides (slide-upload lane): add a PDF, PowerPoint or pictures, choose where to start. */}
              <li className="setup-slides">
                <SlidesSetup publisher={publisher} live={live} state={slideDeck} />
              </li>
              {tokenRequired && tokenCheck.kind !== "ok" ? (
                <SetupRow state="bad" title="Speaker link" detail={tokenText(tokenCheck, tokenRequired)[1]}>
                  <PasteSpeakerLink />
                </SetupRow>
              ) : null}
              {connection.status !== "connected" ? (
                <SetupRow
                  state={connection.status === "failed" ? "bad" : "wait"}
                  title="Connection"
                  detail={
                    connection.status === "failed"
                      ? "Talk Tracks refused the connection. Check your speaker link."
                      : "Connecting…"
                  }
                />
              ) : null}
            </ul>
            <label className="name-field">
              <span>Your name on your ink</span>
              <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="green-go">
              <Button
                label="Go on air"
                variant="primary"
                size="lg"
                width="100%"
                icon={<Icon name="live" />}
                isDisabled={!media || !!mediaError || !canPublish}
                tooltip={goLabel}
                onClick={goOnAir}
              />
              <p className="green-note">{goLabel ?? "Nothing goes out before you go on air."}</p>
            </div>
          </aside>
        ) : panel ? (
          <aside className="side-panel" aria-labelledby="side-heading">
            <header className="side-head">
              <h2 id="side-heading">{{ slides: "Slides", audience: "Audience", questions: "Questions" }[panel]}</h2>
              <button type="button" className="icon-btn" aria-label="Close panel" onClick={() => setPanel(undefined)}>
                <Glyph name="close" />
              </button>
            </header>
            <div className="side-body">
              {panel === "slides" ? (
                <SlidesSetup publisher={publisher} live={live} state={slideDeck} />
              ) : panel === "audience" ? (
                <Audience catalog={catalog} now={now} chat={{ source: chatSource, room, talkClock: clockText }} />
              ) : roomService ? (
                <Questions
                  service={roomService}
                  slide={deck && publisher.deckId !== undefined ? { deck: publisher.deckId, index } : undefined}
                  onSlide={(i) => void goTo(i)}
                />
              ) : (
                <p className="muted small">Questions need the room service, which this console runs without.</p>
              )}
            </div>
          </aside>
        ) : null}
      </div>

      {phase !== "preflight" ? (
        <div className="console-dock" role="group" aria-label="Talk controls">
          <div className="dock-side">{deck ? <SlidePager index={index} count={deck.count} goTo={goTo} /> : null}</div>
          <div className="dock-centre">
            <RoundButton
              icon={snap?.micOn ? "mic" : "micOff"}
              label="Microphone"
              pressed={snap?.micOn ?? false}
              disabled={!media}
              onClick={() => media?.setMic(!snap?.micOn)}
              size="lg"
            />
            <RoundButton
              icon={snap?.cameraOn ? "videocam" : "videocamOff"}
              label="Camera"
              pressed={snap?.cameraOn ?? false}
              disabled={!media}
              onClick={() => media?.setCamera(!snap?.cameraOn)}
              size="lg"
            />
            <RoundButton
              icon={sharing ? "cancelPresentation" : "presentToAll"}
              label={sharing ? "Stop sharing" : "Share screen"}
              pressed={sharing}
              disabled={!media?.shareScreen || (!sharing && !!snap?.screenStarting)}
              onClick={() => (sharing ? media?.stopScreen?.() : void media?.shareScreen?.(withAudio))}
              size="lg"
            />
            {deck ? (
              <RoundButton
                icon={hidden ? "visibilityOff" : "visibility"}
                label="Hide slides"
                hint={hidden ? "Show the slides again (B)" : "Hide the slides from viewers (B)"}
                pressed={hidden}
                onClick={toggleBlank}
                size="lg"
              />
            ) : null}
            {phase === "paused" ? (
              <button type="button" className="dock-pill dock-resume" onClick={resume}>
                <Glyph name="playArrow" />
                Resume
              </button>
            ) : (
              <RoundButton
                icon="pauseFill"
                label="Pause"
                hint="Viewers see that you paused; nothing is lost"
                onClick={pause}
                size="lg"
              />
            )}
            <button type="button" className="dock-pill dock-end" onClick={() => setConfirmEnd(true)}>
              <Glyph name="callEnd" />
              End talk
            </button>
          </div>
          <div className="dock-side dock-panels">
            <PanelButton
              icon="slideshow"
              label="Slides"
              pressed={panel === "slides"}
              onClick={() => setPanel((p) => (p === "slides" ? undefined : "slides"))}
            />
            <PanelButton
              icon="group"
              label="Audience"
              pressed={panel === "audience"}
              onClick={() => setPanel((p) => (p === "audience" ? undefined : "audience"))}
            />
            <PanelButton
              icon="liveHelp"
              label="Questions"
              count={openQuestions}
              pressed={panel === "questions"}
              onClick={() => setPanel((p) => (p === "questions" ? undefined : "questions"))}
            />
          </div>
        </div>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept={SLIDE_ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose slides"
        data-testid="deck-file"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          loadFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** The console's state word: the LIVE marker (icon and word in live red, brand §6) and time on air, or the word. */
function OnAirBadge({ onAir, paused, elapsed }: { onAir: OnAir; paused: boolean; elapsed: number }) {
  if (onAir.kind === "on-air")
    return (
      <span role="status" className="on-air-badge on-air-live" data-state={onAir.kind}>
        <Icon name="live" />
        LIVE <span className="on-air-time">{clockText(elapsed)}</span>
      </span>
    );
  const [variant, label] = paused
    ? (["neutral", `Paused · ${clockText(elapsed)}`] as const)
    : onAir.kind === "confirming" || onAir.kind === "starting"
      ? (["warning", "Connecting…"] as const)
      : onAir.kind === "off"
        ? (["neutral", "Not on air yet"] as const)
        : (["warning", "Not on air"] as const);
  return (
    <span role="status" className="on-air-badge" data-state={paused ? "paused" : onAir.kind}>
      <Badge variant={variant} label={label} />
    </span>
  );
}

function Swatches({
  tool,
  value,
  onChange,
}: {
  tool: keyof ToolColors;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Colour">
      {SWATCHES[tool].map((name) => {
        const color = inkColor(name);
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={color === value}
            aria-label={CHALK_BOX.find((i) => i.name === name)!.label}
            className="swatch"
            style={{ background: color }}
            onClick={() => onChange(color)}
          />
        );
      })}
    </div>
  );
}

function Widths({ value, onChange }: { value: WidthStep; onChange: (w: WidthStep) => void }) {
  return (
    <div className="widths" role="radiogroup" aria-label="Stroke width ([ and ])">
      {([0, 1, 2] as const).map((w) => (
        <button
          key={w}
          type="button"
          role="radio"
          aria-checked={w === value}
          aria-label={WIDTH_NAMES[w]}
          className="width-option"
          onClick={() => onChange(w)}
        >
          <span style={{ height: `${2 + w * 2}px` }} />
        </button>
      ))}
    </div>
  );
}

function WireStatus({
  live,
  clock,
  echo,
  phase,
}: {
  live: boolean;
  clock: ClockState;
  echo: Echo | undefined;
  phase: Phase;
}) {
  if (!live) {
    if (phase === "preflight") return <>Nothing goes out before you go on air.</>;
    if (clock.kind === "no-clock") return <>Your broadcast has no clock: reload and go on air again.</>;
    return <>Slides go out once the room clock starts…</>;
  }
  const counts = Object.values(echo ?? {});
  const ok = counts.reduce((n, c) => n + c.ok, 0);
  const bad = counts.reduce((n, c) => n + c.bad, 0);
  if (bad) return <span className="alert">{bad} slide objects came back malformed; please report this.</span>;
  return ok ? <>Sending slides; viewers receive them ({ok} checked).</> : <>Sending slides…</>;
}

function tokenText(t: TokenCheck, required: boolean): [state: "ok" | "off" | "bad", text: string] {
  switch (t.kind) {
    case "none":
      return required
        ? [
            "bad",
            "This link has no speaker token, so you can't go on air: only a speaker link can start a talk. Paste yours below, or ask the organiser for one.",
          ]
        : ["off", "No speaker token in this link. This local server needs none."];
    case "unreadable":
      return ["bad", "The token in this link is damaged. Ask for a new speaker link."];
    case "expired":
      return ["bad", `The token expired on ${new Date(t.at).toLocaleString()}. Ask for a new speaker link.`];
    case "wrong-room":
      return ["bad", "This token is for another room. Open the speaker link you were given for this room."];
    case "ok":
      return ["ok", t.expires ? `Valid until ${new Date(t.expires).toLocaleString()}.` : "Valid."];
  }
}

/** The wall clock as Meet shows it in its header: "9:40 PM". */
const wallTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A length on air in words for the end screen: "42 min", "1 h 05 min", "under a minute". */
const minutesText = (ms: number) => {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "under a minute";
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
};

/**
 * The console's header, as a call's: top left the time, the talk's title and its room code, and (i) for the talk's
 * details (the audience link, Copy, the QR and the full-screen card to project). Top right, the talk's state.
 */
function ConsoleHeader({
  room,
  title,
  now,
  children,
}: {
  room: string;
  title: string | undefined;
  now: number;
  children?: React.ReactNode;
}) {
  const [details, setDetails] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!details) return;
    pop.current?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setDetails(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [details]);
  const close = () => {
    setDetails(false);
    button.current?.focus();
  };
  return (
    <header className="console-bar">
      <div className="console-meeting">
        <Link href="/" className="console-home" aria-label="Talk Tracks home">
          <LogoMark size={22} />
        </Link>
        <time className="console-clock" dateTime={new Date(now).toISOString()}>
          {wallTime(now)}
        </time>
        <span className="console-sep" aria-hidden="true" />
        <h1 className="console-talk">{title ?? "Untitled talk"}</h1>
        <span className="console-sep" aria-hidden="true" />
        <span className="console-code">
          <span className="sr-only">Room code </span>
          {room}
        </span>
        <button
          ref={button}
          type="button"
          className="icon-btn"
          aria-label="Talk details"
          aria-expanded={details}
          aria-controls="talk-details"
          onClick={() => setDetails((d) => !d)}
        >
          <Glyph name="info" />
        </button>
      </div>
      <div className="console-state">{children}</div>
      {details ? (
        <section
          ref={pop}
          id="talk-details"
          className="details-pop"
          role="dialog"
          aria-labelledby="details-heading"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !e.defaultPrevented) {
              e.stopPropagation();
              close();
            }
          }}
        >
          <header className="details-head">
            <h2 id="details-heading">Talk details</h2>
            <button type="button" className="icon-btn" aria-label="Close talk details" onClick={close}>
              <Glyph name="close" />
            </button>
          </header>
          <div className="details-body">
            <AudienceLink room={room} label="Joining link" />
            <div className="details-qr">
              <QrCode text={watchUrl(room)} label={`QR code for ${watchUrl(room)}`} />
              <div className="details-qr-text">
                <p>
                  Viewers scan it, open the link, or type the room code <strong>{room}</strong> into Join on the Talk
                  Tracks home page.
                </p>
                <ProjectInvite room={room} />
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </header>
  );
}

/** Before slides or a screen: viewers see the camera, or a quiet card with the speaker's name. */
function EmptyStage({ camera, name, busy }: { camera: MediaStreamTrack | undefined; name: string; busy: boolean }) {
  return (
    <div className="stage stage-empty">
      {camera ? (
        <SelfView track={camera} className="stage-self" />
      ) : (
        <div className="stage-nobody">
          <span className="stage-avatar" aria-hidden="true">
            {(name.trim() || "S").slice(0, 1).toUpperCase()}
          </span>
          <span>Your camera is off</span>
        </div>
      )}
      <p className="stage-drop">
        <Glyph name="uploadFile" />
        {busy ? "Opening the PDF…" : "No slides yet. Drop a PDF here, or load one in Slides."}
      </p>
    </div>
  );
}

/** A round icon button (Meet's device toggles): the icon says the state, the name says the device. */
function RoundButton({
  icon,
  label,
  pressed,
  disabled,
  onClick,
  hint,
  size = "md",
}: {
  icon: GlyphName;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  hint?: string;
  size?: "md" | "lg";
}) {
  return (
    <button
      type="button"
      className={`round-btn round-${size}`}
      aria-label={label}
      aria-pressed={pressed}
      title={hint ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      <Glyph name={icon} />
    </button>
  );
}

/** The one slide counter, with the steps either side: under the preview before air, in the dock on air. */
function SlidePager({ index, count, goTo }: { index: number; count: number; goTo: (i: number) => unknown }) {
  return (
    <nav className="slide-pager" aria-label="Slides">
      <RoundButton
        icon="chevronLeft"
        label="Previous slide"
        hint="Previous slide (←)"
        disabled={index === 0}
        onClick={() => void goTo(index - 1)}
      />
      <span className="slide-count" aria-live="polite" data-testid="slide-count">
        {`${index + 1} / ${count}`}
      </span>
      <RoundButton
        icon="chevronRight"
        label="Next slide"
        hint="Next slide (→)"
        disabled={index + 1 >= count}
        onClick={() => void goTo(index + 1)}
      />
    </nav>
  );
}

/** A panel toggle at the dock's right (Meet's people and chat buttons), with a count when there is news. */
function PanelButton({
  icon,
  label,
  pressed,
  count = 0,
  onClick,
}: {
  icon: GlyphName;
  label: string;
  pressed: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="panel-btn"
      aria-label={count ? `${label} (${count} open)` : label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
    >
      <Glyph name={icon} />
      {count ? (
        <span className="panel-count" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </button>
  );
}

type SetupState = "ok" | "wait" | "bad" | "off";
const STATE_WORD: Record<SetupState, string> = { ok: "Ready", wait: "Waiting", bad: "Needs you", off: "Off" };

/** One source in the green room: its toggle, its name and device, its state, and what else it needs. */
function SetupRow({
  state,
  control,
  title,
  detail,
  children,
}: {
  state: SetupState;
  control?: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="setup-row" data-state={state}>
      <div className="setup-main">
        {control ?? <span className="setup-icon" aria-hidden="true" />}
        <div className="setup-text">
          <span className="setup-title">{title}</span>
          <span className="setup-detail">{detail}</span>
        </div>
        <span className="setup-state">{STATE_WORD[state]}</span>
      </div>
      {children ? <div className="setup-extra">{children}</div> : null}
    </li>
  );
}

/** The green room's one sentence: what is left before going on air. */
function readiness(snap: MediaSnapshot | undefined, heard: boolean, deck: boolean, canPublish: boolean): string {
  if (!canPublish) return "This link cannot go on air yet: it needs your speaker link.";
  if (!snap) return "Starting your microphone and camera…";
  if (snap.micError) return "Your microphone needs you before you go on air.";
  if (!snap.micOn) return "Turn on your microphone to check your level, or go on air: it turns on then.";
  if (!heard) return "Say a few words: the level bar should move.";
  return deck
    ? "We hear you and your slides are in. Go on air when you are ready."
    : "We hear you. Slides are optional.";
}

/** The device in use: a picker when there is a choice, else the words for its state. */
function DevicePicker({
  label,
  devices,
  value,
  onChange,
  fallback,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  value: string | undefined;
  onChange: (id: string) => void;
  fallback: string;
}) {
  const named = devices.filter((d) => d.deviceId);
  if (named.length < 2) return <>{fallback}</>;
  return (
    <select
      className="device"
      aria-label={`${label} device`}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      {named.map((d, i) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `${label} ${i + 1}`}
        </option>
      ))}
    </select>
  );
}

/**
 * The end of the talk: how long it ran, what the replay keeps, the replay link to copy or open, and the two ways on
 * (another talk, or the hub).
 */
function Ended({
  room,
  title,
  now,
  ending,
  retry,
  onAirMs,
  slideCount,
  still,
  made,
}: {
  room: string;
  title: string | undefined;
  now: number;
  ending: Ending;
  retry: () => void;
  onAirMs: number;
  slideCount: number;
  still: string | undefined;
  made: string[];
}) {
  const url = watchUrl(room);
  const { copied, copy } = useCopy(url);
  return (
    <div className="console console-ended" data-phase="ended">
      <ConsoleHeader room={room} title={title} now={now}>
        <span role="status" className="ended-state">
          {/* Until the room service acknowledges, viewers may still see "Paused". */}
          {ending === "ending" ? "Ending…" : "Ended"}
        </span>
      </ConsoleHeader>
      {ending === "refused" ? (
        <Banner
          status="warning"
          title="Talk Tracks did not take the end of the talk"
          description="Viewers may see the talk as paused. This link may not be the speaker's, or it expired."
          role="alert"
          endContent={<Button label="Try again" size="sm" variant="secondary" onClick={retry} />}
        />
      ) : null}
      <main id="main" className="ended">
        <div className="ended-head">
          <h1 className="ended-title">Talk ended</h1>
          <p className="ended-sub">
            {title ? <>{title} · </> : null}
            {minutesText(onAirMs)} on air
          </p>
        </div>
        <div className="ended-grid">
          <section className="ended-replay" aria-labelledby="replay-heading">
            <a className="ended-still" href={url} target="_blank" rel="noreferrer" aria-label="Open the replay">
              {still ? <img src={still} alt="" /> : <span className="ended-still-title">{title ?? room}</span>}
              <span className="ended-play" aria-hidden="true">
                <Glyph name="playArrow" />
              </span>
            </a>
            <h2 id="replay-heading" className="ended-label">
              Replay
            </h2>
            <div className="ended-link">
              <span className="ended-url">{shortUrl(url)}</span>
              {/* Plain buttons: the page's one live region is the talk's state ("Ending…", "Ended"). */}
              <button type="button" className="ended-btn" onClick={() => void copy()}>
                <Glyph name={copied === "yes" ? "checkCircle" : "contentCopy"} />
                {copied === "yes" ? "Copied" : "Copy replay link"}
              </button>
              <a className="ended-open" href={url} target="_blank" rel="noreferrer">
                <Glyph name="openInNew" />
                Open replay
              </a>
            </div>
            <span className="ended-copied" aria-live="polite">
              {copied === "yes" ? "Replay link copied." : copied === "no" ? "Could not copy; select the link." : ""}
            </span>
          </section>
          <section className="ended-kept" aria-labelledby="kept-heading">
            <h2 id="kept-heading" className="ended-label">
              Kept in the replay
            </h2>
            <ul className="kept-list">
              <li>
                <Glyph name="mic" />
                <span className="kept-what">Your voice and camera</span>
                <span className="kept-fact">{minutesText(onAirMs)}</span>
              </li>
              <li>
                <Glyph name="slideshow" />
                <span className="kept-what">Slides, with everything you drew and pointed at</span>
                <span className="kept-fact">{slideCount ? `${slideCount} slides` : "No slides"}</span>
              </li>
              <li>
                <Glyph name="subtitles" />
                <span className="kept-what">Subtitles, translations and chapters</span>
                <span className="kept-fact">{made.length ? made.join(", ") : "Made as listeners turn them on"}</span>
              </li>
            </ul>
          </section>
        </div>
        <nav className="ended-actions" aria-label="What next">
          <button type="button" className="ended-btn ended-btn-primary" onClick={() => navigate("/?start")}>
            <Glyph name="add" />
            Start another talk
          </button>
          <Link href="/" className="ended-hub">
            <Glyph name="arrowBack" />
            Back to the hub
          </Link>
        </nav>
      </main>
    </div>
  );
}

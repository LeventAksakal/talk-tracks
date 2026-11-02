import { AlertDialog, Badge, Banner, Button, Switch, ToggleButton } from "@astryxdesign/core";
import {
  type ChangeEvent,
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
import { Link } from "../router";
import { useResource } from "../useResource";
import { MoqTransport } from "../transport/moq";
import type { ConnectionStatus, Transport } from "../transport/types";
import { Audience } from "./Audience";
import { type ClockState, clockState, roomNowFn, wallNowMs } from "./clock";
import type { Deck, RenderedSlide } from "./deck";
import { type Echo, watchEcho } from "./echo";
import { type EndOutcome, endRoomOnce, untilAnswered } from "./endRoom";
import { Invite, watchUrl } from "./Invite";
import { type Tool, isShapeTool, keyAction } from "./keys";
import type { MediaSnapshot, SpeakerMedia } from "./media";
import { LevelMeter, ScreenPreview, SelfView, useLevel } from "./MediaViews";
import { useNotes } from "./notes";
import { FRESH_AUDIO_MS, isOwnAudio, onAirState, type OnAir } from "./onair";
import { SlidesPublisher } from "./publisher";
import { Questions, useQuestionCounts } from "./Questions";
import { type BroadcastSink, lazyBroadcast } from "./sink";
import { Stage, type ToolColors, type WidthStep, colorKey } from "./Stage";
import { type TokenCheck, checkToken } from "./token";
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
  openDeck: (file: File) => Promise<Deck>;
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

/** The toolbar, in groups; the digit keys pick tools in this order (keys.ts TOOL_ORDER). */
const TOOLS: { tool: Tool; label: string; key: string }[][] = [
  [
    { tool: "laser", label: "Laser", key: "L" },
    { tool: "pen", label: "Pen", key: "D" },
    { tool: "highlighter", label: "Highlighter", key: "H" },
  ],
  [
    { tool: "rect", label: "Rectangle", key: "R" },
    { tool: "ellipse", label: "Ellipse", key: "O" },
    { tool: "arrow", label: "Arrow", key: "A" },
    { tool: "line", label: "Line", key: "I" },
    { tool: "diamond", label: "Diamond", key: "G" },
  ],
  [
    { tool: "underline", label: "Underline text", key: "U" },
    { tool: "highlight", label: "Highlight text", key: "M" },
    { tool: "eraser", label: "Eraser", key: "E" },
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

  // --- the deck ------------------------------------------------------------------------------------
  const [deck, setDeck] = useState<Deck>();
  const [slides, setSlides] = useState<RenderedSlide[]>([]);
  const [deckBusy, setDeckBusy] = useState(false);
  const [deckError, setDeckError] = useState<string>();
  const [index, setIndex] = useState(0);
  const [hidden, setHidden] = useState(false);
  const loading = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [notes, setNote] = useNotes(deck?.fingerprint);
  useEffect(() => () => deck?.close(), [deck]);

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

  const ensureSlide = useCallback(
    async (d: Deck, i: number) => {
      const s = await d.render(i);
      if (publisher.deckId !== undefined && !publisher.hasImage(i)) publisher.addImage(s.image);
      setSlides((prev) => {
        const next = [...prev];
        next[i] = s;
        return next;
      });
      return s;
    },
    [publisher],
  );

  const goTo = useCallback(
    async (i: number) => {
      if (!deck || i < 0 || i >= deck.count) return;
      const s = await ensureSlide(deck, i);
      publisher.show(i);
      sendFrame(s);
      setIndex(i);
      setHidden(false);
    },
    [deck, ensureSlide, publisher, sendFrame],
  );

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    const token = ++loading.current;
    setDeckBusy(true);
    setDeckError(undefined);
    try {
      const d = await deps.openDeck(file);
      if (token !== loading.current) return d.close();
      publisher.loadDeck({ kind: "deck", count: d.count, aspect: d.aspect, title: d.title });
      setSlides([]);
      setDeck(d);
      const first = await ensureSlide(d, 0);
      publisher.show(0);
      sendFrame(first);
      setIndex(0);
      setHidden(false);
      for (let i = 1; i < d.count && token === loading.current; i++) await ensureSlide(d, i);
    } catch (e) {
      if (token === loading.current) setDeckError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === loading.current) setDeckBusy(false);
    }
  };

  // Once live, the describe agent gets the slide on screen.
  useEffect(() => {
    if (live) sendFrame(slides[index]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on going live
  }, [live]);

  const toggleBlank = useCallback(() => {
    if (!deck) return;
    if (hidden) void goTo(index);
    else {
      publisher.hide();
      setHidden(true);
    }
  }, [deck, hidden, goTo, index, publisher]);

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
    setPhase("ended");
  };

  if (phase === "ended") return <Ended room={room} ending={ending} retry={sayEnded} />;

  const current = slides[index];
  const next = deck && index + 1 < deck.count ? slides[index + 1] : undefined;
  const aspect = deck?.aspect ?? 16 / 9;
  const slideLabel = deck ? `Slide ${index + 1} of ${deck.count}${hidden ? ", hidden from viewers" : ""}` : "No slides";

  return (
    <div className="console" data-phase={phase}>
      <header className="console-bar">
        <div className="console-title">
          <Link href="/" className="brand">
            Talk Tracks
          </Link>
          <h1>
            Speaking in <span className="console-room">{room}</span>
          </h1>
        </div>
        <div className="console-actions">
          <OnAirBadge onAir={onAir} paused={phase === "paused"} elapsed={phase !== "preflight" ? now - startedAt : 0} />
          {phase === "preflight" ? (
            <Button
              label="Go on air"
              variant="primary"
              icon={<Icon name="live" />}
              isDisabled={!media || !!mediaError}
              tooltip={!media ? "Waiting for the microphone and camera to load" : undefined}
              onClick={goOnAir}
            />
          ) : (
            <>
              {phase === "paused" ? (
                <Button label="Resume" variant="primary" icon={<Icon name="play" />} onClick={resume} />
              ) : (
                <Button
                  label="Pause"
                  variant="secondary"
                  icon={<Icon name="pause" />}
                  tooltip="Viewers see that you paused; nothing is lost"
                  onClick={pause}
                />
              )}
              <Button
                label="End talk"
                variant="destructive"
                icon={<Icon name="stop" />}
                onClick={() => setConfirmEnd(true)}
              />
            </>
          )}
        </div>
      </header>
      <AlertDialog
        isOpen={confirmEnd}
        onOpenChange={setConfirmEnd}
        title="End the talk?"
        description="Viewers see that the talk ended, and nothing more goes out. The recording, slides and everything drawn on them stay replayable."
        cancelLabel="Keep talking"
        actionLabel="End talk"
        onAction={endTalk}
      />
      {onAir.kind === "refused" || onAir.kind === "error" ? (
        <Banner status="warning" title="Not on air" description={onAir.reason} role="alert" />
      ) : null}
      {connection.status === "disconnected" && phase === "on-air" ? (
        <Banner
          status="warning"
          title="Connection to the relay dropped"
          description="Reconnecting. Keep talking: the console sends again as soon as it is back."
          role="alert"
        />
      ) : null}

      <div className="console-grid">
        <aside className="console-side">
          <Sources
            phase={phase}
            media={media}
            snap={snap}
            mediaError={mediaError}
            level={level}
            name={name}
            setName={setName}
            deck={deck}
            deckBusy={deckBusy}
            deckError={deckError}
            rendered={slides.filter(Boolean).length}
            pickFile={() => fileInput.current?.click()}
            tokenCheck={tokenCheck}
            connection={connection.status}
            clock={clock}
          />
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose a PDF deck"
            data-testid="deck-file"
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              void loadFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Invite room={room} />
        </aside>

        <main
          id="main"
          className="console-main"
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            void loadFile(e.dataTransfer.files[0]);
          }}
        >
          <div className="panel-head">
            <h2 className="panel-title">What viewers see</h2>
            <span className="muted small" data-testid="wire-status">
              <WireStatus live={live} clock={clock} echo={echo} phase={phase} />
            </span>
          </div>
          <div className="stage-wrap" onPointerDownCapture={() => setOptionsOpen(false)}>
            {snap?.screenTrack ? (
              // While a screen is shared, viewers see it in place of the slides (the camera stays in the corner).
              <ScreenPreview track={snap.screenTrack} className="stage stage-screen" />
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
              <div className="stage stage-empty" style={{ aspectRatio: String(aspect) }}>
                <p>Load your slides as a PDF (export from PowerPoint, Keynote or Google Slides), or drop one here.</p>
                <Button label="Load slides" variant="primary" onClick={() => fileInput.current?.click()} />
              </div>
            )}
            <SelfView track={snap?.cameraTrack} className="stage-camera" />
          </div>
          <div className="toolbar" role="toolbar" aria-label="Drawing tools">
            {TOOLS.map((group, i) => (
              <div key={i} className="toolbar-group">
                {group.map((t) => {
                  const options = tool === t.tool && hasOptions(t.tool);
                  return (
                    <span key={t.tool} className="tool-slot">
                      <ToggleButton
                        label={`${t.label} (${t.key})`}
                        size="sm"
                        isPressed={tool === t.tool}
                        isDisabled={!deck}
                        onPressedChange={() => pickTool(t.tool)}
                      >
                        {t.label}
                      </ToggleButton>
                      {options ? (
                        <button
                          type="button"
                          className="tool-options-toggle"
                          aria-label={`${t.label} colour and width`}
                          aria-expanded={optionsOpen}
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
            <div className="toolbar-group">
              <Button
                label="Undo"
                tooltip="Undo (Ctrl+Z)"
                size="sm"
                variant="secondary"
                isDisabled={!deck || hidden || !history.includes("u")}
                onClick={() => publisher.undo()}
              />
              <Button
                label="Redo"
                tooltip="Redo (Ctrl+Y)"
                size="sm"
                variant="secondary"
                isDisabled={!deck || hidden || !history.includes("r")}
                onClick={() => publisher.redo()}
              />
              <Button
                label="Clear slide"
                size="sm"
                variant="secondary"
                isDisabled={!deck || hidden}
                onClick={() => publisher.clearSlide()}
              />
            </div>
          </div>
          <nav className="slide-nav" aria-label="Slides">
            <Button label="Previous" size="sm" isDisabled={!deck || index === 0} onClick={() => void goTo(index - 1)} />
            <span className="slide-count" aria-live="polite" data-testid="slide-count">
              {deck ? `${index + 1} / ${deck.count}` : "– / –"}
            </span>
            <Button
              label="Next"
              size="sm"
              isDisabled={!deck || index + 1 >= deck.count}
              onClick={() => void goTo(index + 1)}
            />
            <Button
              label={hidden ? "Show slides (B)" : "Hide slides (B)"}
              size="sm"
              variant="secondary"
              isDisabled={!deck}
              onClick={toggleBlank}
            />
          </nav>
        </main>

        <aside className="console-presenter" aria-label="Presenter view (only you see this)">
          <section className="panel">
            <h2 className="panel-title">Next</h2>
            {next ? (
              <img className="next-slide" src={next.url} alt={`Slide ${index + 2}`} />
            ) : (
              <p className="muted small">{deck ? "This is the last slide." : "No slides yet."}</p>
            )}
          </section>
          <section className="panel notes">
            <label htmlFor="notes" className="panel-title">
              Your notes for slide {deck ? index + 1 : "–"}
            </label>
            <textarea
              id="notes"
              className="notes-text"
              disabled={!deck}
              value={notes[index] ?? ""}
              onChange={(e) => setNote(index, e.target.value)}
              placeholder="Only you see these. They stay in this browser and are never sent."
            />
          </section>
          <Questions
            service={roomService}
            slide={deck && publisher.deckId !== undefined ? { deck: publisher.deckId, index } : undefined}
            onSlide={(i) => void goTo(i)}
          />
          {deck ? (
            <section className="panel">
              <h2 className="panel-title">All slides</h2>
              <ol className="strip">
                {Array.from({ length: deck.count }, (_, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="strip-item"
                      aria-current={i === index ? "true" : undefined}
                      onClick={() => void goTo(i)}
                      aria-label={`Show slide ${i + 1}${questionCounts.get(i) ? `, ${questionCounts.get(i)} questions` : ""}`}
                    >
                      {slides[i] ? <img src={slides[i].url} alt="" /> : <span className="strip-wait" />}
                      <span className="strip-num">{i + 1}</span>
                      {questionCounts.get(i) ? (
                        <span className="strip-questions" aria-hidden="true">
                          {questionCounts.get(i)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </aside>
      </div>
      <Audience catalog={catalog} now={now} chat={{ source: chatSource, room, talkClock: clockText }} />
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
    return <>Slides go out once the room service starts the room clock…</>;
  }
  const counts = Object.values(echo ?? {});
  const ok = counts.reduce((n, c) => n + c.ok, 0);
  const bad = counts.reduce((n, c) => n + c.bad, 0);
  if (bad) return <span className="alert">{bad} slide objects came back malformed; please report this.</span>;
  return ok ? <>Sending slides; viewers receive them ({ok} checked).</> : <>Sending slides…</>;
}

function Check({
  state,
  title,
  children,
}: {
  state: "ok" | "wait" | "bad" | "off";
  title: string;
  children?: React.ReactNode;
}) {
  const word = { ok: "Ready", wait: "Waiting", bad: "Needs you", off: "Off" }[state];
  return (
    <li className={`check check-${state}`}>
      <span className="check-state">{word}</span>
      <div className="check-body">
        <span className="check-title">{title}</span>
        {children}
      </div>
    </li>
  );
}

function tokenText(t: TokenCheck): [state: "ok" | "wait" | "bad", text: string] {
  switch (t.kind) {
    case "none":
      return [
        "wait",
        "No speaker token in this link. A local relay works without one; on the public relay, ask for a speaker link.",
      ];
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

function Sources(props: {
  phase: Phase;
  media: SpeakerMedia | undefined;
  snap: MediaSnapshot | undefined;
  mediaError: string | undefined;
  level: number;
  name: string;
  setName: (name: string) => void;
  deck: Deck | undefined;
  deckBusy: boolean;
  deckError: string | undefined;
  rendered: number;
  pickFile: () => void;
  tokenCheck: TokenCheck;
  connection: ConnectionStatus;
  clock: ClockState;
}) {
  const { media, snap, deck } = props;
  const [tokenState, tokenMessage] = tokenText(props.tokenCheck);
  // Once this microphone has been heard it stays ready: speech has pauses.
  const [heard, setHeard] = useState<MediaStreamTrack>();
  const micTrack = snap?.micTrack;
  if (micTrack && props.level > 0.25 && heard !== micTrack) setHeard(micTrack);
  const micState = snap?.micError ? "bad" : snap?.micOn ? (micTrack && heard === micTrack ? "ok" : "wait") : "off";
  return (
    <section className="panel sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading" className="panel-title">
        {props.phase === "preflight" ? "Before going on air" : "Sources"}
      </h2>
      {props.mediaError ? (
        <p className="alert" role="alert">
          The microphone and camera could not load: {props.mediaError}
        </p>
      ) : null}
      <ul className="checks">
        <Check state={micState} title="Microphone">
          <div className="row">
            <Switch
              label="Microphone on"
              isLabelHidden
              value={snap?.micOn ?? false}
              isDisabled={!media}
              onChange={(on) => media?.setMic(on)}
            />
            <LevelMeter level={props.level} label="Microphone level" />
          </div>
          <DevicePicker
            label="Microphone"
            devices={snap?.micDevices ?? []}
            value={snap?.micDevice}
            onChange={(id) => media?.chooseMic(id)}
          />
          <p className="muted small">
            {snap?.micError ??
              (snap?.micOn
                ? micState === "ok"
                  ? "We hear you."
                  : "Say something: the bar should move."
                : "Turn it on to check your level. Going on air needs it.")}
          </p>
        </Check>
        <Check
          state={snap?.cameraError ? "bad" : snap?.cameraOn ? (snap.cameraTrack ? "ok" : "wait") : "off"}
          title="Camera"
        >
          <div className="row">
            <Switch
              label="Camera on"
              isLabelHidden
              value={snap?.cameraOn ?? false}
              isDisabled={!media}
              onChange={(on) => media?.setCamera(on)}
            />
            <span className="muted small">{snap?.cameraOn ? "Viewers see you beside the slides." : "Optional."}</span>
          </div>
          <SelfView track={snap?.cameraTrack} />
          <DevicePicker
            label="Camera"
            devices={snap?.cameraDevices ?? []}
            value={snap?.cameraDevice}
            onChange={(id) => media?.chooseCamera(id)}
          />
          {snap?.cameraError ? <p className="alert small">{snap.cameraError}</p> : null}
        </Check>
        <ScreenCheck media={media} snap={snap} />
        <Check
          state={props.deckError ? "bad" : deck ? (props.rendered >= deck.count ? "ok" : "wait") : "off"}
          title="Slides"
        >
          <p className="small">
            {props.deckError ??
              (deck
                ? `${deck.name}: ${deck.count} slides${props.rendered < deck.count ? `, preparing ${props.rendered} of ${deck.count}` : ""}.`
                : props.deckBusy
                  ? "Opening the PDF…"
                  : "No slides. Optional: you can talk without them.")}
          </p>
          <Button
            label={deck ? "Change slides" : "Load slides"}
            size="sm"
            variant="secondary"
            onClick={props.pickFile}
          />
        </Check>
        <Check state={tokenState} title="Speaker token">
          <p className="small">{tokenMessage}</p>
        </Check>
        <Check
          state={props.connection === "connected" ? "ok" : props.connection === "failed" ? "bad" : "wait"}
          title="Relay"
        >
          <p className="small">
            {props.connection === "connected"
              ? "Connected."
              : props.connection === "failed"
                ? "The relay refused the connection. Check the token."
                : "Connecting…"}
          </p>
        </Check>
        {props.phase === "on-air" || props.clock.kind === "ready" ? (
          <Check
            state={props.clock.kind === "ready" ? "ok" : props.clock.kind === "no-clock" ? "bad" : "wait"}
            title="Room clock"
          >
            <p className="small">
              {props.clock.kind === "ready"
                ? props.clock.local
                  ? "Local clock (development: no room service)."
                  : "Set by the room service: slides, ink and laser line up with your voice."
                : props.clock.kind === "no-clock"
                  ? "Your broadcast carries no clock. Reload the page and go on air again."
                  : "Waiting for the room service to start the room clock…"}
            </p>
          </Check>
        ) : null}
      </ul>
      <label className="name-field">
        <span className="small">Your name, as viewers see it on your ink</span>
        <input
          type="text"
          value={props.name}
          maxLength={60}
          disabled={props.phase !== "preflight"}
          onChange={(e) => props.setName(e.target.value)}
        />
      </label>
    </section>
  );
}

/** Share a screen, window or tab, optionally with its sound; stop it here or from the browser's own bar. */
function ScreenCheck({ media, snap }: { media: SpeakerMedia | undefined; snap: MediaSnapshot | undefined }) {
  const [withAudio, setWithAudio] = useState(false);
  const sharing = !!snap?.screenTrack;
  const canShare = !!media?.shareScreen;
  return (
    <Check state={snap?.screenError ? "bad" : sharing ? "ok" : snap?.screenStarting ? "wait" : "off"} title="Screen">
      <div className="row">
        {sharing ? (
          <Button label="Stop sharing" size="sm" variant="secondary" onClick={() => media?.stopScreen?.()} />
        ) : (
          <Button
            label="Share screen"
            size="sm"
            variant="secondary"
            isDisabled={!canShare || snap?.screenStarting}
            onClick={() => void media?.shareScreen?.(withAudio)}
          />
        )}
        <Switch
          label="With its sound"
          value={withAudio}
          isDisabled={!canShare || sharing || snap?.screenStarting}
          onChange={setWithAudio}
        />
      </div>
      <p className="muted small">
        {snap?.screenError ??
          (sharing
            ? `Viewers see your screen in place of the slides${snap?.screenAudio ? ", and hear its sound" : ""}.`
            : snap?.screenStarting
              ? "Pick what to share in your browser's window."
              : "Optional: a demo or code. Its sound goes out only with a tab, or a whole screen on Windows.")}
      </p>
    </Check>
  );
}

function DevicePicker({
  label,
  devices,
  value,
  onChange,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const named = devices.filter((d) => d.deviceId);
  if (named.length < 2) return null;
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

function Ended({ room, ending, retry }: { room: string; ending: Ending; retry: () => void }) {
  const url = watchUrl(room);
  return (
    <div className="console console-ended">
      <header className="console-bar">
        <div className="console-title">
          <Link href="/" className="brand">
            Talk Tracks
          </Link>
          <h1>
            Talk ended in <span className="console-room">{room}</span>
          </h1>
        </div>
        <span role="status">
          {/* Until the room service acknowledges, viewers may still see "Paused". */}
          <Badge variant="neutral" label={ending === "ending" ? "Ending…" : "Ended"} />
        </span>
      </header>
      {ending === "refused" ? (
        <Banner
          status="warning"
          title="The room service did not take the end of the talk"
          description="Viewers may see the talk as paused. This link may not be the speaker's, or it expired."
          role="alert"
          endContent={<Button label="Try again" size="sm" variant="secondary" onClick={retry} />}
        />
      ) : null}
      <section className="panel ended-panel">
        <h2 className="panel-title">What is kept</h2>
        <ul>
          <li>The recording of your voice and camera.</li>
          <li>Your slides, with everything you drew, underlined and pointed at, in time with your voice.</li>
          <li>Subtitles, translations and chapters that listeners turned on.</li>
        </ul>
        <p>
          Anyone can replay it at <a href={url}>{url}</a>.
        </p>
        <p className="muted small">Your notes stay in this browser; they were never sent.</p>
      </section>
    </div>
  );
}

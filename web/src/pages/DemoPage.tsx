import { useState } from "react";
import type { Playback } from "../playback/playback";
import { createDemoPlayback } from "../playback/usePlayback";
import { DemoSlides } from "../player/demoSlides";
import { Player } from "../player/Player";
import { SlideTracks } from "../player/slideTracks";
import { PLAYER_STATES, type PlayerStateKind } from "../player/state";
import { useLocation } from "../router";
import { FakeTransport } from "../transport/fake";
import { useResource } from "../useResource";

export const DEMO_ROOM = "demo";

/** How far into the scripted talk the demo opens, ms: some history to rewind into, a few chapters. */
export const DEMO_START_MS = 150_000;

/** The scripted talk's length, ms (the demo's agents run as long). */
const DEMO_DURATION_MS = 3_600_000;

interface Demo {
  playback: Playback;
  slides: SlideTracks;
  close(): void;
}

/**
 * The scripted room: its agents on one fake relay (createDemoPlayback); its speaker's slides, ink, marks and
 * laser, a listener's annotations and the room's state on another, both on the same room clock.
 */
function createDemo(): Demo {
  const playback = createDemoPlayback(DEMO_ROOM, DEMO_START_MS, { arabic: true });
  const script = new DemoSlides(DEMO_ROOM, DEMO_DURATION_MS);
  script.start(DEMO_START_MS);
  const slides = new SlideTracks(script.source, DEMO_ROOM, { catalog: () => script.catalog });
  // The console and the room service publish as room time passes: the live edge of the demo's media clock.
  const timer = setInterval(() => script.advanceTo(playback.liveEdge() ?? DEMO_START_MS), 50);
  return {
    playback,
    slides,
    close() {
      clearInterval(timer);
      slides.close();
      playback.close();
    },
  };
}

/**
 * The player on a scripted room: works offline, with no relay and no agents. `?state=<kind>` previews a
 * player state of ui-design §5 (paused, ended, reconnecting, …) for screenshots.
 */
export function DemoPage() {
  const [transport] = useState(() => new FakeTransport());
  const demo = useResource(createDemo, []);
  const { search } = useLocation();
  const asked = new URLSearchParams(search).get("state");
  const forceState = PLAYER_STATES.find((s) => s === asked) as PlayerStateKind | undefined;
  if (!demo) return null;
  return (
    <Player
      playback={demo.playback}
      slides={demo.slides}
      room={DEMO_ROOM}
      transport={transport}
      title="How rivers shape the land"
      speaker="Demo speaker"
      credit="a scripted talk"
      notice={
        <span title="A scripted talk replayed in this tab: its agents publish 4 s slices the way real ones do, and its speaker shows slides, draws and points. No relay, no audio or video.">
          Offline demo
        </span>
      }
      sources={["camera", "slides"]}
      forceState={forceState}
    />
  );
}

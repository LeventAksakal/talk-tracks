import { useState } from "react";
import { createDemoPlayback } from "../playback/usePlayback";
import { Player } from "../player/Player";
import { PLAYER_STATES, type PlayerStateKind } from "../player/state";
import { useLocation } from "../router";
import { FakeTransport } from "../transport/fake";
import { useResource } from "../useResource";

export const DEMO_ROOM = "demo";

/** How far into the scripted talk the demo opens, ms: some history to rewind into, a few chapters. */
export const DEMO_START_MS = 150_000;

/**
 * The player on a scripted room: works offline, with no relay and no agents. `?state=<kind>` previews a
 * player state of ui-design §5 (paused, ended, reconnecting, …) for screenshots.
 */
export function DemoPage() {
  const [transport] = useState(() => new FakeTransport());
  const playback = useResource(() => createDemoPlayback(DEMO_ROOM, DEMO_START_MS, { arabic: true }), []);
  const { search } = useLocation();
  const asked = new URLSearchParams(search).get("state");
  const forceState = PLAYER_STATES.find((s) => s === asked) as PlayerStateKind | undefined;
  if (!playback) return null;
  return (
    <Player
      playback={playback}
      room={DEMO_ROOM}
      transport={transport}
      title="How rivers shape the land"
      speaker="Demo speaker"
      credit="a scripted talk"
      notice={
        <span title="A scripted talk replayed in this tab, its agents publishing 4 s slices the way real ones do. No relay, no audio or video.">
          Offline demo
        </span>
      }
      sources={["camera", "slides"]}
      forceState={forceState}
    />
  );
}

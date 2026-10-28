import { useEffect, useSyncExternalStore } from "react";
import { MoqTransport } from "../transport/moq";
import type { Transport } from "../transport/types";
import { useResource } from "../useResource";
import { FakeHistorySource } from "./fakeSource";
import { FakeRoom, fakeTalk } from "./fixtures";
import { ClockMedia, RoomMedia } from "./media";
import { MoqHistorySource } from "./moqSource";
import { Playback, type PlaybackView } from "./playback";

/** A Playback for a room on the relay: AI tracks over MoQ, speaker media live and from the archive. */
export function createRoomPlayback(transport: MoqTransport, room: string): Playback {
  return new Playback(new MoqHistorySource(transport), new RoomMedia(transport, room), room);
}

/**
 * An offline room for trying rewind with no relay: a scripted talk that started `startMs` ago, its
 * agents publishing on a FakeHistorySource, and a media clock with no sound.
 */
export function createDemoPlayback(room: string, startMs = 180_000): Playback {
  const source = new FakeHistorySource();
  source.fetchDelayMs = 60;
  const talk = fakeTalk(3_600_000);
  const fake = new FakeRoom(source, room, talk);
  const t0 = Date.now() - startMs;
  fake.start(startMs);
  const media = new ClockMedia();
  media.setLiveEdge(startMs);
  const timer = setInterval(() => fake.advanceTo(Date.now() - t0), 250);
  return new Playback(source, media, room, { onClose: () => clearInterval(timer) });
}

/** The room's Playback for the component's lifetime: over the relay for a MoqTransport, none otherwise. */
export function usePlayback(transport: Transport | undefined, room: string): Playback | undefined {
  return useResource(
    () => (transport instanceof MoqTransport ? createRoomPlayback(transport, room) : undefined),
    [transport, room],
  );
}

export function usePlaybackView(playback: Playback | undefined): PlaybackView | undefined {
  const view = useSyncExternalStore(playback?.subscribe ?? noopSubscribe, playback?.getSnapshot ?? undefinedSnapshot);
  // Time away from a hidden tab is "what you missed" (design §5.6).
  useEffect(() => {
    if (!playback) return;
    const onVisibility = () => playback.setAway(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [playback]);
  return view;
}

const noopSubscribe = () => () => {};
const undefinedSnapshot = () => undefined;

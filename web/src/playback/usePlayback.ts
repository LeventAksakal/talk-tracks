import { useEffect, useState, useSyncExternalStore } from "react";
import { MoqTransport } from "../transport/moq";
import type { Transport } from "../transport/types";
import { FakeHistorySource } from "./fakeSource";
import { FakeRoom, fakeTalk } from "./fixtures";
import { ClockMedia, RoomMedia } from "./media";
import { MoqHistorySource } from "./moqSource";
import { Playback, type PlaybackView } from "./playback";
import { watchSessions } from "./session";

/** A Playback for a room on the relay: AI tracks over MoQ, speaker media live and from the archive. */
export function createRoomPlayback(transport: MoqTransport, room: string): Playback {
  const media = new RoomMedia(transport, room);
  return new Playback(new MoqHistorySource(transport), media, room, {
    catalog: () => media.catalog(),
  });
}

/**
 * An offline room for trying rewind with no relay: a scripted talk that started `startMs` ago, its
 * agents publishing on a FakeHistorySource, and a media clock with no sound.
 */
export function createDemoPlayback(room: string, startMs = 180_000, options: { arabic?: boolean } = {}): Playback {
  const source = new FakeHistorySource();
  source.fetchDelayMs = 60;
  const talk = fakeTalk(3_600_000, options);
  const fake = new FakeRoom(source, room, talk);
  const t0 = Date.now() - startMs;
  fake.start(startMs);
  const media = new ClockMedia();
  media.setLiveEdge(startMs);
  const timer = setInterval(() => fake.advanceTo(Date.now() - t0), 250);
  const catalog = fake.catalog();
  return new Playback(source, media, room, { catalog: () => catalog, onClose: () => clearInterval(timer) });
}

/**
 * The room's Playback for the component's lifetime: over the relay for a MoqTransport, none otherwise. When a demo
 * session ends and the next starts (decision 0032), the playback says so (the end card), and a fresh one joins the
 * new session from 00:00; the old one closes after the new one is handed out, so the player never unmounts.
 */
export function usePlayback(transport: Transport | undefined, room: string): Playback | undefined {
  const [playback, setPlayback] = useState<Playback>();
  useEffect(() => {
    if (!(transport instanceof MoqTransport)) return;
    let current = createRoomPlayback(transport, room);
    let stop: () => void;
    const watch = (pb: Playback) => {
      const media = pb.media as RoomMedia;
      stop = watchSessions(media, {
        ended: () => pb.endSession(),
        restart: () => {
          const next = createRoomPlayback(transport, room);
          stop();
          current = next;
          watch(next);
          setPlayback(next);
          pb.close();
        },
      });
    };
    watch(current);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publishing the resource is the point
    setPlayback(current);
    return () => {
      stop();
      current.close();
      setPlayback(undefined);
    };
  }, [transport, room]);
  return playback;
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

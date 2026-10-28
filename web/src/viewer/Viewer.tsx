import { Badge, Switch } from "@astryxdesign/core";
import { useState } from "react";
import { toAgentView } from "../playback/agentViews";
import type { Playback } from "../playback/playback";
import { PlaybackBar } from "../playback/PlaybackBar";
import { usePlayback, usePlaybackView } from "../playback/usePlayback";
import type { AgentView, RoomStoreOptions, RoomView } from "../room/store";
import { useRoom } from "../room/useRoom";
import { Link } from "../router";
import type { ConnectionStatus, Transport } from "../transport/types";
import { CaptionsPanel, OutlinePanel, SlidesPanel, stateOf, TrackPicker, TranslationPanel } from "./panels";

/** Viewers start with every track but translations; the translation into their own language is on too. */
export function viewerDefaults(
  language = typeof navigator !== "undefined" ? navigator.language : "en",
): RoomStoreOptions {
  const own = language.toLowerCase().split("-")[0];
  return {
    subscribeByDefault: (agent) => !agent.startsWith("translate-") || agent === `translate-${own}`,
  };
}

/**
 * The viewer for one room, over any Transport: the live relay on /watch, the script on /demo. Speaker
 * media and the sliced AI tracks (decision 0012) go through the playback layer, which rewinds them;
 * `playback` overrides the one made for a relay transport (the offline rewind demo).
 */
export function Viewer({
  transport,
  room,
  title,
  playback: given,
}: {
  transport: Transport | undefined;
  room: string;
  title?: string;
  playback?: Playback;
}) {
  const [view, store] = useRoom(transport, room, viewerDefaults());
  const own = usePlayback(given ? undefined : transport, room);
  const playback = given ?? own;
  const playbackView = usePlaybackView(playback);
  const [hideOriginal, setHideOriginal] = useState(false);

  if (!view || !store) return <p className="page-pad">Connecting…</p>;

  // A room on the sliced contract has its tracks in the playback layer; an older room in the RoomStore.
  const sliced = playback !== undefined && playbackView !== undefined && playbackView.tracks.tracks.length > 0;
  const agents = sliced ? playbackView.tracks.tracks.map((t) => toAgentView(t)) : view.agents;
  const toggle = (name: string, on: boolean) =>
    sliced ? playback.tracks.setEnabled(name, on) : store.setSubscribed(name, on);
  const captions = agents.filter((a) => a.kind === "captions" && a.subscribed);
  const translations = agents.filter((a) => a.kind === "translation" && a.subscribed);
  const slides = agents.filter((a) => a.kind === "slides" && a.subscribed);
  const outlines = agents.filter((a) => a.kind === "outline" && a.subscribed);
  const firstLine = stateOf(captions[0], "captions")?.lines[0]?.start_ms;
  const showCaptions = !(hideOriginal && translations.length > 0);
  const snapshots = view.agents.reduce((n, a) => n + a.historyLength, 0);

  return (
    <div className="viewer">
      <header className="room-header">
        <div className="room-title">
          <Link href="/" className="brand">
            Talk Tracks
          </Link>
          <h1>{title ?? `Room ${room}`}</h1>
        </div>
        <LiveIndicator view={view} agents={agents} />
      </header>

      <div className="viewer-grid">
        <aside className="viewer-side" aria-label="Speaker and tracks">
          {playback && playbackView ? <PlaybackBar playback={playback} view={playbackView} /> : null}
          <TrackPicker agents={agents} onToggle={toggle} />
          {translations.length > 0 ? (
            <section className="panel">
              <Switch
                label="Show translation only"
                description="Hide the original-language captions."
                value={hideOriginal}
                onChange={setHideOriginal}
              />
            </section>
          ) : null}
        </aside>

        <main className="viewer-main" id="main">
          {captions.length === 0 && translations.length === 0 ? (
            <p className="muted panel">Turn on captions or a translation under Tracks to follow the talk as text.</p>
          ) : null}
          <div className={`text-tracks count-${(showCaptions ? captions.length : 0) + translations.length}`}>
            {showCaptions ? captions.map((a) => <CaptionsPanel key={a.name} agent={a} />) : null}
            {translations.map((a) => (
              <TranslationPanel key={a.name} agent={a} />
            ))}
          </div>
        </main>

        <aside className="viewer-extra" aria-label="Slides and outline">
          {slides.map((a) => (
            <SlidesPanel key={a.name} agent={a} />
          ))}
          {outlines.map((a) => (
            <OutlinePanel key={a.name} agent={a} origin={firstLine} />
          ))}
        </aside>
      </div>
      <footer className="viewer-footer muted">
        {snapshots} snapshot{snapshots === 1 ? "" : "s"} kept in this tab · connection {statusText(view.status)}
      </footer>
    </div>
  );
}

function LiveIndicator({ view, agents }: { view: RoomView; agents: readonly AgentView[] }) {
  const anyLive = agents.some((a: AgentView) => a.health === "live");
  if (view.status === "failed") return <Badge variant="error" label="Offline" />;
  if (view.status !== "connected") return <Badge variant="warning" label="Connecting" />;
  return anyLive || view.teacherLive ? (
    <span className="live-badge" role="status">
      <Badge variant="error" label="● Live" />
    </span>
  ) : (
    <Badge variant="neutral" label="Waiting for the talk" />
  );
}

function statusText(status: ConnectionStatus): string {
  return status === "connected" ? "open" : status === "failed" ? "failed" : status;
}

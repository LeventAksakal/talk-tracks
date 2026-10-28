import { Badge, Switch } from "@astryxdesign/core";
import { useState } from "react";
import { type AgentView, toAgentView } from "../playback/agentViews";
import type { Playback } from "../playback/playback";
import { Inspector } from "../playback/Inspector";
import { PlaybackBar } from "../playback/PlaybackBar";
import { usePlayback, usePlaybackView } from "../playback/usePlayback";
import { type RoomStatus, useRoomStatus } from "../playback/roomStatus";
import { Link } from "../router";
import type { ConnectionStatus, Transport } from "../transport/types";
import { CaptionsPanel, OutlinePanel, SlidesPanel, stateOf, TrackPicker, TranslationPanel } from "./panels";

/**
 * The viewer for one room: the live relay on /watch, a fake room on /demo. Speaker media and the AI
 * tracks (envelope v2, decision 0012) go through the playback layer, which rewinds them; `playback`
 * overrides the one made for a relay transport (the offline demos). No track is on until chosen
 * (decision 0010).
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
  const view = useRoomStatus(transport, room);
  const own = usePlayback(given ? undefined : transport, room);
  const playback = given ?? own;
  const playbackView = usePlaybackView(playback);
  const [hideOriginal, setHideOriginal] = useState(false);

  if (!view || !playback || !playbackView) return <p className="page-pad">Connecting…</p>;

  const agents = playbackView.tracks.tracks.map((t) => toAgentView(t));
  const toggle = (name: string, on: boolean) => playback.tracks.setEnabled(name, on);
  const captions = agents.filter((a) => a.kind === "captions" && a.subscribed);
  const translations = agents.filter((a) => a.kind === "translation" && a.subscribed);
  const slides = agents.filter((a) => a.kind === "slides" && a.subscribed);
  const outlines = agents.filter((a) => a.kind === "outline" && a.subscribed);
  const firstLine = stateOf(captions[0], "captions")?.lines[0]?.start_ms;
  const showCaptions = !(hideOriginal && translations.length > 0);
  const slices = agents.reduce((n, a) => n + a.historyLength, 0);

  return (
    <div className="viewer">
      <header className="room-header">
        <div className="room-title">
          <Link href="/" className="brand">
            Talk Tracks
          </Link>
          <h1>{title ?? `Room ${room}`}</h1>
        </div>
        <LiveIndicator view={view} agents={agents} onAir={playback.media.onAir?.()} />
      </header>

      <div className="viewer-grid">
        <aside className="viewer-side" aria-label="Speaker and tracks">
          <PlaybackBar playback={playback} view={playbackView} />
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
          <Inspector playback={playback} />
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
        {slices} slice{slices === 1 ? "" : "s"} held in this tab · connection {statusText(view.status)}
      </footer>
    </div>
  );
}

function LiveIndicator({
  view,
  agents,
  onAir,
}: {
  view: RoomStatus;
  agents: readonly AgentView[];
  /** From the speaker media itself: the relay announces a broadcast arriving, never one leaving. */
  onAir: boolean | undefined;
}) {
  const anyLive = agents.some((a: AgentView) => a.health === "live");
  if (view.status === "failed") return <Badge variant="error" label="Offline" />;
  if (view.status !== "connected") return <Badge variant="warning" label="Connecting" />;
  return anyLive || (onAir ?? view.teacherLive) ? (
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

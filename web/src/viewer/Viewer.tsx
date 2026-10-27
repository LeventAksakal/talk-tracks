import { Badge, Switch } from "@astryxdesign/core";
import { useState } from "react";
import type { AgentView, RoomStoreOptions, RoomView } from "../room/store";
import { useRoom } from "../room/useRoom";
import { Link } from "../router";
import { MoqTransport } from "../transport/moq";
import type { ConnectionStatus, Transport } from "../transport/types";
import { CaptionsPanel, OutlinePanel, SlidesPanel, stateOf, TrackPicker, TranslationPanel } from "./panels";
import { TeacherMedia } from "./TeacherMedia";

/** Viewers start with every track but translations; the translation into their own language is on too. */
export function viewerDefaults(
  language = typeof navigator !== "undefined" ? navigator.language : "en",
): RoomStoreOptions {
  const own = language.toLowerCase().split("-")[0];
  return {
    subscribeByDefault: (agent) => !agent.startsWith("translate-") || agent === `translate-${own}`,
  };
}

/** The viewer for one room, over any Transport: the live relay on /watch, the script on /demo. */
export function Viewer({ transport, room, title }: { transport: Transport | undefined; room: string; title?: string }) {
  const [view, store] = useRoom(transport, room, viewerDefaults());
  const [hideOriginal, setHideOriginal] = useState(false);

  if (!view || !store) return <p className="page-pad">Connecting…</p>;

  const captions = view.agents.filter((a) => a.kind === "captions" && a.subscribed);
  const translations = view.agents.filter((a) => a.kind === "translation" && a.subscribed);
  const slides = view.agents.filter((a) => a.kind === "slides" && a.subscribed);
  const outlines = view.agents.filter((a) => a.kind === "outline" && a.subscribed);
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
        <LiveIndicator view={view} />
      </header>

      <div className="viewer-grid">
        <aside className="viewer-side" aria-label="Speaker and tracks">
          {transport instanceof MoqTransport ? (
            <TeacherMedia transport={transport} room={room} live={view.teacherLive} />
          ) : null}
          <TrackPicker agents={view.agents} onToggle={(name, on) => store.setSubscribed(name, on)} />
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

function LiveIndicator({ view }: { view: RoomView }) {
  const anyLive = view.agents.some((a: AgentView) => a.health === "live");
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

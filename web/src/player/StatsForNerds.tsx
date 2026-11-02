import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toAgentView } from "../playback/agentViews";
import { MoqHistorySource } from "../playback/moqSource";
import type { HistorySource } from "../playback/source";
import { type RoomCatalog, statusOf } from "../playback/roomCatalog";
import { formatClock } from "../playback/timeline";
import { MoqTransport } from "../transport/moq";
import { usePlayer } from "./context";
import { Icon } from "./icons";
import { byNamespace, StatsFeed } from "./roomStats";

/**
 * Stats for nerds (ui-design §4.8): a translucent panel over the canvas, from Settings or a right-click. Per
 * track: on or off, producing or idle, slices held, FETCHes the agent served as origin (the rest came from
 * the relay's cache), back-fills; the connection; and the frame clock against the playhead. No money: cost is the
 * operator's concern (decision 0026). Below them, the room's stats track (ticket 0022): every track of the room by
 * broadcast, running or on demand, and the sessions subscribed at the relay; read only while the panel is open.
 */
export function StatsForNerds() {
  const { playback, view, media, transport, setUi, clock, tracks, roomName, talkClock } = usePlayer();
  const source = useMemo(
    () => (transport instanceof MoqTransport ? new MoqHistorySource(transport) : undefined),
    [transport],
  );
  const catalog = useSyncExternalStore(
    (fn) => media?.onChange(fn) ?? (() => {}),
    () => media?.catalog(),
  );
  const [conn, setConn] = useState<{ kind?: string; rtt?: number }>({});
  useEffect(() => {
    if (!(transport instanceof MoqTransport)) return;
    const read = () =>
      setConn({
        kind: transport.connection.transport.peek(),
        rtt: transport.connection.probe.peek()?.rtt,
      });
    read();
    const timer = setInterval(read, 1_000);
    return () => clearInterval(timer);
  }, [transport]);

  const t = view.timeline;
  const frame = clock.now();
  const pos = playback.position();
  const all = view.tracks.tracks;
  // One row per track this player uses; the rest of the room's tracks (a room can offer forty translations) are one
  // summary row, and listed below by the room's stats track.
  const on = all.filter((t) => t.enabled);
  const off = all.filter((t) => !t.enabled);

  return (
    <section className="tt-stats" aria-label="Stats for nerds">
      <div className="tt-stats-head">
        <strong>Stats for nerds</strong>
        <button
          type="button"
          className="tt-icon-button tt-small"
          aria-label="Close stats"
          onClick={() => setUi({ stats: false })}
        >
          <Icon name="close" />
        </button>
      </div>
      <table>
        <tbody>
          <Row
            k="connection"
            v={
              transport?.kind === "fake"
                ? "offline demo (no relay)"
                : `${conn.kind ?? "connecting"}${conn.rtt === undefined ? "" : ` · rtt ${Math.round(conn.rtt)} ms`}`
            }
          />
          <Row k="mode" v={`${t.mode}${t.mode === "rewound" ? ` · ${formatClock(t.behindMs)} behind` : ""}`} />
          <Row k="media" v={`${t.mediaStatus}${playback.media.error() ? ` · ${playback.media.error()}` : ""}`} />
          <Row
            k="playhead"
            v={`${pos === undefined ? "–" : talkClock(pos)} · live edge ${t.liveEdge === undefined ? "–" : talkClock(t.liveEdge)}`}
          />
          <Row
            k="frame clock"
            v={
              frame === undefined || pos === undefined
                ? "–"
                : `${talkClock(frame)} · ${Math.round(frame - pos)} ms from the playhead`
            }
          />
          {on.map((track) => {
            const agent = toAgentView(track);
            const s = statusOf(catalog as RoomCatalog | undefined, track.agent);
            const held = agent.historyLength;
            const parts = [
              track.enabled ? `on · ${agent.health}` : "off",
              s ? (s.status === "live" && !s.producing ? "live, waiting" : s.status) : undefined,
              track.enabled
                ? `${held} slice${held === 1 ? "" : "s"} held${track.loading ? " · fetching" : ""}`
                : undefined,
              s ? `origin ${s.fetches_served} · back-fills ${s.backfills}` : undefined,
            ].filter(Boolean);
            return <Row key={track.id} k={track.label} v={parts.join(" · ")} />;
          })}
          {all.length === 0 ? <Row k="tracks" v="no agents announced yet" /> : null}
          {off.length > 0 ? (
            <Row k={on.length > 0 ? "other tracks" : "tracks"} v={`${off.length} offered, off: ${offSummary(off)}`} />
          ) : null}
          <Row
            k="subtitles"
            v={tracks.captions?.lastLiveAt ? `last line ${ago(tracks.captions.lastLiveAt)}` : "no live line yet"}
          />
          {source ? <RoomTracks source={source} room={roomName} /> : null}
        </tbody>
      </table>
    </section>
  );
}

/**
 * The room's tracks from talk/<room>/stats: one row per broadcast, with its subscribers and each track running or on
 * demand. Mounted, it subscribes; unmounted, it unsubscribes.
 */
export function RoomTracks({ source, room }: { source: HistorySource; room: string }) {
  const feed = useMemo(() => new StatsFeed(source, room), [source, room]);
  useEffect(() => {
    feed.start();
    return () => feed.stop();
  }, [feed]);
  useSyncExternalStore(feed.subscribe, feed.getVersion);
  const { phase, stats } = feed.view();
  if (!stats) {
    return (
      <Row k="room tracks" v={phase === "loading" ? "loading…" : "the room service sends no stats for this room"} />
    );
  }
  const prefix = `talk/${room}/`;
  return (
    <>
      <Row
        k="room"
        v={`${stats.listeners} listener${stats.listeners === 1 ? "" : "s"} connected${stats.relay ? "" : " · relay counts unknown"}`}
      />
      {byNamespace(stats).map((g) => (
        <Row
          key={g.namespace}
          k={`${g.namespace.startsWith(prefix) ? g.namespace.slice(prefix.length) : g.namespace}${
            g.subscribers === undefined ? "" : ` · ${g.subscribers} subscribed`
          }`}
          v={g.tracks
            .map((t) => `${t.name}${t.lang ? ` (${t.lang})` : ""} ${t.state === "running" ? "running" : "on demand"}`)
            .join(" · ")}
        />
      ))}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <th scope="row">{k}</th>
      <td>{v}</td>
    </tr>
  );
}

/** "Captions, Slide descriptions, 38 translations": translations counted, other tracks named. */
function offSummary(tracks: readonly { kind?: string; label: string }[]): string {
  const translations = tracks.filter((t) => t.kind === "translation").length;
  const named = tracks.filter((t) => t.kind !== "translation").map((t) => t.label);
  return [...named, ...(translations ? [`${translations} translation${translations === 1 ? "" : "s"}`] : [])].join(
    ", ",
  );
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return `${s} s ago`;
}

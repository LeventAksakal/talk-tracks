import { useEffect, useState, useSyncExternalStore } from "react";
import { toAgentView } from "../playback/agentViews";
import { type RoomCatalog, statusOf } from "../playback/roomCatalog";
import { formatClock } from "../playback/timeline";
import { MoqTransport } from "../transport/moq";
import { usePlayer } from "./context";
import { Icon } from "./icons";

/**
 * Stats for nerds (ui-design §4.8): a translucent panel over the canvas, from Settings or a right-click. Per
 * track: on or off, producing or idle, slices held, FETCHes the agent served as origin (the rest came from
 * the relay's cache), back-fills, spend; the connection; and the frame clock against the playhead.
 */
export function StatsForNerds() {
  const { playback, view, media, transport, setUi, clock, tracks } = usePlayer();
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
  const total = Object.values(catalog?.tt.status ?? {}).reduce((n, s) => n + s.spend_usd, 0);
  const all = view.tracks.tracks;

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
            v={`${pos === undefined ? "–" : formatClock(pos)} · live edge ${t.liveEdge === undefined ? "–" : formatClock(t.liveEdge)}`}
          />
          <Row
            k="frame clock"
            v={
              frame === undefined || pos === undefined
                ? "–"
                : `${formatClock(frame)} · ${Math.round(frame - pos)} ms from the playhead`
            }
          />
          {all.map((track) => {
            const agent = toAgentView(track);
            const s = statusOf(catalog as RoomCatalog | undefined, track.agent);
            const held = agent.historyLength;
            const parts = [
              track.enabled ? `on · ${agent.health}` : "off",
              s ? (s.status === "live" && !s.producing ? "live, waiting" : s.status) : undefined,
              track.enabled ? `${held} slice${held === 1 ? "" : "s"} held${track.loading ? " · fetching" : ""}` : undefined,
              s ? `origin ${s.fetches_served} · back-fills ${s.backfills}` : undefined,
              s ? `$${s.spend_usd.toFixed(3)}` : undefined,
            ].filter(Boolean);
            return <Row key={track.id} k={track.label} v={parts.join(" · ")} />;
          })}
          {all.length === 0 ? <Row k="tracks" v="no agents announced yet" /> : null}
          {catalog ? <Row k="spend" v={`$${total.toFixed(3)} in this room`} /> : null}
          <Row
            k="subtitles"
            v={tracks.captions?.lastLiveAt ? `last line ${ago(tracks.captions.lastLiveAt)}` : "no live line yet"}
          />
        </tbody>
      </table>
    </section>
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

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return `${s} s ago`;
}

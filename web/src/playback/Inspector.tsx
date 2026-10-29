// What the relay and the agents are doing, for judges (design §5.10): per agent, live, idle or capped;
// FETCHes it served as origin (relay cache misses, the rest came from the relay's cache); back-fills; and
// spend. All of it from the room catalog's `tt.status`; reading it subscribes to the room service only.

import { useSyncExternalStore } from "react";
import { RoomMedia } from "./media";
import type { Playback } from "./playback";
import { latenessOf, type RoomCatalog, statusOf } from "./roomCatalog";
import { agentPath } from "./wire";

export function Inspector({ playback }: { playback: Playback }) {
  const media = playback.media instanceof RoomMedia ? playback.media : undefined;
  const catalog = useSyncExternalStore(
    (fn) => media?.onChange(fn) ?? (() => {}),
    () => media?.catalog(),
  );
  if (!media) return null;
  return (
    <details className="panel inspector">
      <summary className="panel-title">Inspector</summary>
      {catalog ? (
        <InspectorTable catalog={catalog} room={playback.tracks.room} />
      ) : (
        <p className="muted">Waiting for the room catalog.</p>
      )}
    </details>
  );
}

function InspectorTable({ catalog, room }: { catalog: RoomCatalog; room: string }) {
  const prefix = agentPath(room, "");
  const agents = new Set([
    ...catalog.tracks.filter((t) => t.namespace.startsWith(prefix)).map((t) => t.namespace.slice(prefix.length)),
    ...Object.keys(catalog.tt.status ?? {}),
  ]);
  const total = Object.values(catalog.tt.status ?? {}).reduce((n, s) => n + s.spend_usd, 0);
  if (agents.size === 0) return <p className="muted">No agents in the catalog yet.</p>;
  return (
    <table className="inspector-table">
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col">Status</th>
          <th scope="col" title="FETCHes the agent answered itself because the relay had no copy">
            Origin FETCHes
          </th>
          <th scope="col">Back-fills</th>
          <th scope="col">Spend</th>
        </tr>
      </thead>
      <tbody>
        {[...agents].sort().map((agent) => {
          const s = statusOf(catalog, agent);
          const track = catalog.tracks.find((t) => t.namespace === prefix + agent);
          const l = track ? latenessOf(catalog, track.namespace, track.name) : undefined;
          return (
            <tr key={agent}>
              <th scope="row" title={l === undefined ? undefined : `Publishes up to ${l / 1000} s late`}>
                {track?.label ?? agent}
              </th>
              <td>{s ? (s.status === "live" && !s.producing ? "live, waiting" : s.status) : "–"}</td>
              <td>{s?.fetches_served ?? "–"}</td>
              <td>{s?.backfills ?? "–"}</td>
              <td>{s ? `$${s.spend_usd.toFixed(3)}` : "–"}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={4}>
            Spend in this room
          </th>
          <td>${total.toFixed(3)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

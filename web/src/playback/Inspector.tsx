// What the relay and the agents are doing, per track, for judges (design §5.10): producing or idle,
// FETCHes the agent served as origin (relay cache misses), back-fills, and spend. All of it from the
// room catalog's `tt.status`; reading it subscribes to the room service only.

import { useSyncExternalStore } from "react";
import { RoomMedia } from "./media";
import type { Playback } from "./playback";
import type { RoomCatalog } from "./roomCatalog";

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
      {catalog ? <InspectorTable catalog={catalog} /> : <p className="muted">Waiting for the room catalog.</p>}
    </details>
  );
}

function InspectorTable({ catalog }: { catalog: RoomCatalog }) {
  const keys = new Set([...catalog.tracks.map((t) => `${t.namespace}/${t.name}`), ...Object.keys(catalog.status)]);
  const total = Object.values(catalog.status).reduce((n, s) => n + s.spendUsd, 0);
  if (keys.size === 0) return <p className="muted">No tracks in the catalog yet.</p>;
  return (
    <table className="inspector-table">
      <thead>
        <tr>
          <th scope="col">Track</th>
          <th scope="col">Producing</th>
          <th scope="col" title="FETCHes the agent answered itself: the relay had no copy">
            Origin
          </th>
          <th scope="col" title="FETCHes the relay answered from its cache">
            Cached
          </th>
          <th scope="col">Back-fills</th>
          <th scope="col">Spend</th>
        </tr>
      </thead>
      <tbody>
        {[...keys].sort().map((key) => {
          const s = catalog.status[key];
          const track = catalog.tracks.find((t) => `${t.namespace}/${t.name}` === key);
          return (
            <tr key={key}>
              <th scope="row" title={track ? `L = ${track.latenessMs / 1000} s` : undefined}>
                {shortName(key)}
              </th>
              <td>{s ? (s.capped ? "capped" : s.producing ? "yes" : "idle") : "–"}</td>
              <td>{s?.originFetches ?? "–"}</td>
              <td>{s?.cachedFetches ?? "–"}</td>
              <td>{s?.backfills ?? "–"}</td>
              <td>{s ? `$${s.spendUsd.toFixed(3)}` : "–"}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={5}>
            Spend in this room
          </th>
          <td>${total.toFixed(3)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** `talk/R/agents/captions/items` → `captions/items`. */
function shortName(key: string): string {
  const i = key.indexOf("/agents/");
  return i >= 0 ? key.slice(i + "/agents/".length) : key.split("/").slice(2).join("/");
}

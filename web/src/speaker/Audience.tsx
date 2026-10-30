import type { RoomCatalog, TrackStatus } from "../contracts/types";
import { statusOf } from "../playback/roomCatalog";

/** What a listener calls an agent's feature. */
export function featureName(agent: string): string {
  if (agent === "captions") return "Subtitles";
  if (agent === "describe") return "Audio description";
  if (agent === "chapters") return "Chapters";
  const lang = /^translate-(.+)$/.exec(agent)?.[1];
  if (lang) {
    let name = lang;
    try {
      name = new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
    } catch {
      // not a language tag: keep it as it is
    }
    return `Subtitles in ${name}`;
  }
  return agent;
}

export interface Feature {
  agent: string;
  name: string;
  status: TrackStatus;
}

export function features(catalog: RoomCatalog | undefined, now = Date.now()): Feature[] {
  return Object.keys(catalog?.tt.status ?? {})
    .sort()
    .flatMap((agent) => {
      const status = statusOf(catalog, agent, now);
      return status ? [{ agent, name: featureName(agent), status }] : [];
    });
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** Audience (S4): which features listeners have on, spend per feature, alerts only when due. */
export function Audience({ catalog, now }: { catalog: RoomCatalog | undefined; now: number }) {
  const list = features(catalog, now);
  const total = list.reduce((sum, f) => sum + f.status.spend_usd, 0);
  const capped = list.filter((f) => f.status.status === "capped");
  return (
    <section className="panel audience" aria-labelledby="audience-heading">
      <div className="panel-head">
        <h2 id="audience-heading" className="panel-title">
          Audience
        </h2>
        <span className="audience-total" data-testid="spend-total">
          Spend {money(total)}
        </span>
      </div>
      {capped.length ? (
        <p className="alert" role="alert">
          The room reached its spending cap: {capped.map((f) => f.name).join(", ")} stopped.
        </p>
      ) : null}
      {!catalog ? (
        <p className="muted small">No room service yet: features and spend show here once it lists this room.</p>
      ) : list.length === 0 ? (
        <p className="muted small">No feature has been asked for yet. Each one starts when a listener turns it on.</p>
      ) : (
        <table className="features">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Listeners</th>
              <th scope="col" className="num">
                Spend
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.agent}>
                <th scope="row">{f.name}</th>
                <td>
                  {f.status.status === "capped"
                    ? "Stopped: cap reached"
                    : f.status.producing
                      ? "In use"
                      : "Nobody has it on"}
                </td>
                <td className="num">{money(f.status.spend_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Viewer counts are not reported by the room service yet.</p>
    </section>
  );
}

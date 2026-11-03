import { Button } from "@astryxdesign/core";
import { useState } from "react";
import type { RoomCatalog, TrackStatus } from "../contracts/types";
import { statusOf } from "../playback/roomCatalog";
import type { HistorySource } from "../playback/source";
import { Chat } from "../player/Chat";

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

/** The room's chat as the console shows it: read from talk/<room>/chat, never written from here. */
export interface AudienceChat {
  /** Where the chat track is read from; undefined without a relay. */
  source: HistorySource | undefined;
  room: string;
  /** A message's room time as the console shows it. */
  talkClock: (ms: number) => string;
}

/**
 * Audience (S4): which features listeners are using and which are unavailable, with no money (decision 0026: cost is
 * the operator's concern), and the room's chat, read-only. Listener counts per track come from the room's stats
 * track once ticket 0022 is answered; their column goes here.
 */
export function Audience({
  catalog,
  now,
  chat,
}: {
  catalog: RoomCatalog | undefined;
  now: number;
  chat?: AudienceChat;
}) {
  const list = features(catalog, now);
  const unavailable = list.filter((f) => f.status.status === "capped");
  return (
    <section className="panel audience" aria-labelledby="audience-heading">
      <div className="panel-head">
        <h2 id="audience-heading" className="panel-title">
          Audience
        </h2>
      </div>
      {unavailable.length ? (
        <p className="alert" role="alert">
          Unavailable right now: {unavailable.map((f) => f.name).join(", ")}.
        </p>
      ) : null}
      {!catalog ? (
        <p className="muted small">
          What viewers turn on (subtitle languages, chapters, slide descriptions) shows here once you are on air.
        </p>
      ) : list.length === 0 ? (
        <p className="muted small">No feature in use yet. Each one starts when a listener picks or opens it.</p>
      ) : (
        <table className="features">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.agent}>
                <th scope="row">{f.name}</th>
                <td>
                  {f.status.status === "capped"
                    ? "Unavailable right now"
                    : f.status.producing
                      ? "In use"
                      : "Nobody is using it"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {chat ? <ChatArea {...chat} /> : null}
    </section>
  );
}

/**
 * The chat in the audience area, closed at first. Open, it subscribes to the chat track and shows the conversation
 * (the last messages, then each new one); closed, it unsubscribes (decision 0026: a panel is a subscription). The
 * speaker reads it here; listeners write in the player.
 */
function ChatArea({ source, room, talkClock }: AudienceChat) {
  const [open, setOpen] = useState(false);
  return (
    <div className="audience-chat">
      <Button
        label={open ? "Hide chat" : "Show chat"}
        variant="secondary"
        size="sm"
        aria-expanded={open}
        aria-controls="audience-chat"
        onClick={() => setOpen((o) => !o)}
      />
      {open ? (
        <div id="audience-chat" className="audience-chat-body" role="region" aria-label="Chat">
          <Chat source={source} room={room} rewound={false} at={undefined} talkClock={talkClock} readOnly />
        </div>
      ) : null}
    </div>
  );
}

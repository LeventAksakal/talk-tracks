// What the viewer's panels show for one AI track: a TrackView of the playback layer (at the playhead)
// as the track's full state. The panels render states, so they show a rewound track unchanged.

import type { State, StateKind } from "../contracts/types";
import type { TrackView } from "./aiTracks";

export type Health = "waiting" | "live" | "stale" | "gone";

export interface AgentView {
  /** `<agent>/<track>`: what the track toggle names. */
  name: string;
  label: string;
  model: string | undefined;
  kind: StateKind | undefined;
  lang: string | undefined;
  /** Whether this viewer opted into the track. */
  subscribed: boolean;
  health: Health;
  lastObjectAt: number | undefined;
  /** The track's state at the playhead (live: the newest). */
  latest: { state: State; receivedAt: number } | undefined;
  /** Media held for the track, in 4 s slices. */
  historyLength: number;
  costUsd: number;
  requests: number;
}

const STALE_MS = 6_000;

export function toAgentView(t: TrackView, now: number = Date.now()): AgentView {
  const state = stateOf(t);
  const health: Health = !t.announced
    ? t.lastLiveAt === undefined
      ? "waiting"
      : "gone"
    : t.lastLiveAt === undefined
      ? "waiting"
      : now - t.lastLiveAt > STALE_MS && t.kind !== "outline"
        ? "stale"
        : "live";
  return {
    name: t.id,
    label: t.label,
    model: t.model,
    kind: t.kind,
    lang: t.lang,
    subscribed: t.enabled,
    health,
    lastObjectAt: t.lastLiveAt,
    latest: state && { state, receivedAt: t.lastLiveAt ?? 0 },
    historyLength: t.held.reduce((n, r) => n + Math.round((r.end - r.start) / 4_000), 0),
    costUsd: t.costUsd,
    requests: t.requests,
  };
}

function stateOf(t: TrackView): State | undefined {
  const lang = t.lang ?? "en";
  if (t.kind === "outline") {
    const o = t.outline;
    return o && { kind: "outline", lang: o.lang || lang, chapters: o.chapters, glossary: o.glossary, recap: o.recap };
  }
  const v = t.sliced;
  if (!v) return undefined;
  if (t.kind === "slides")
    return {
      kind: "slides",
      lang,
      slides: v.slides.map((s) => ({ id: s.id, at_ms: s.atMs, description: s.description })),
    };
  const finals = v.lines.filter((l) => l.final);
  const interim = v.lines.filter((l) => !l.final).at(-1)?.text ?? "";
  if (t.kind === "translation")
    return { kind: "translation", lang, lines: finals.map((l) => ({ id: l.id, text: l.text })) };
  return {
    kind: "captions",
    lang,
    lines: finals.map((l) => ({ id: l.id, start_ms: l.startMs, end_ms: l.endMs, text: l.text })),
    interim,
  };
}

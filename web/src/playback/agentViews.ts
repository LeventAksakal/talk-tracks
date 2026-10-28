// Today's viewer panels read a RoomStore AgentView holding a v1 full-state envelope. This turns a
// playback TrackView (at the playhead) into one, so the panels show sliced tracks unchanged until the UI
// lane replaces them.

import type { LegacyEnvelope, State } from "../contracts/types";
import type { AgentView, Health } from "../room/store";
import type { TrackView } from "./aiTracks";

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
  const envelope: LegacyEnvelope | undefined = state && {
    v: 1,
    agent: { name: t.agent, label: t.label, model: t.model ?? "" },
    instance: "",
    seq: 0,
    at_ms: t.lastLiveAt ?? 0,
    usage: { cost_usd: t.costUsd, requests: t.requests },
    state,
  };
  return {
    name: t.id,
    label: t.label,
    model: t.model,
    kind: t.kind,
    lang: t.lang,
    instance: undefined,
    instances: [],
    subscribed: t.enabled,
    health,
    lastObjectAt: t.lastLiveAt,
    latest: envelope && { envelope, receivedAt: t.lastLiveAt ?? 0 },
    historyLength: t.held.length,
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

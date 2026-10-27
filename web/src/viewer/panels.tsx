import { Badge, Button, StatusDot, Switch } from "@astryxdesign/core";
import { useEffect, useId, useRef, useState } from "react";
import type { CaptionsState, OutlineState, SlidesState, TranslationState } from "../contracts/types";
import type { AgentView, Health } from "../room/store";
import { dirOf, formatMediaTime, languageName, nativeLanguageName } from "./lang";
import { ScrollLog } from "./ScrollLog";
import { useSpeech } from "./speech";

export function stateOf<K extends AgentView["kind"]>(
  agent: AgentView | undefined,
  kind: K,
): Extract<CaptionsState | TranslationState | SlidesState | OutlineState, { kind: K }> | undefined {
  const state = agent?.latest?.envelope.state;
  return state && state.kind === kind ? (state as never) : undefined;
}

const HEALTH_TEXT: Record<Health, string> = {
  waiting: "waiting",
  live: "live",
  stale: "no update for a while",
  gone: "gone",
};

export function HealthDot({ health }: { health: Health }) {
  const variant =
    health === "live" ? "success" : health === "stale" ? "warning" : health === "gone" ? "error" : "neutral";
  return (
    <span className="health">
      <StatusDot variant={variant} label={HEALTH_TEXT[health]} isPulsing={health === "live"} />
      <span className="health-text">{HEALTH_TEXT[health]}</span>
    </span>
  );
}

// --- track picker ----------------------------------------------------------------------------------

export function TrackPicker({
  agents,
  onToggle,
}: {
  agents: readonly AgentView[];
  onToggle: (agent: string, subscribed: boolean) => void;
}) {
  return (
    <section className="panel track-picker" aria-labelledby="tracks-heading">
      <h2 id="tracks-heading" className="panel-title">
        Tracks
      </h2>
      {agents.length === 0 ? (
        <p className="muted">No AI tracks in this room yet. They appear here as agents join.</p>
      ) : (
        <ul className="track-list">
          {agents.map((a) => (
            <li key={a.name} className="track-item">
              <Switch
                label={trackLabel(a)}
                description={a.model ? `${a.model}` : undefined}
                value={a.subscribed}
                onChange={(checked) => onToggle(a.name, checked)}
              />
              {a.subscribed ? (
                <HealthDot health={a.health} />
              ) : (
                <span className="health">
                  <span className="health-text muted">Off</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function trackLabel(agent: AgentView): string {
  if (agent.kind === "translation" && agent.lang) {
    const native = nativeLanguageName(agent.lang);
    const local = languageName(agent.lang);
    return native && native !== local ? `Translation: ${local} (${native})` : `Translation: ${local}`;
  }
  return agent.label;
}

// --- captions ------------------------------------------------------------------------------------

export function CaptionsPanel({ agent }: { agent: AgentView }) {
  const state = stateOf(agent, "captions");
  const lines = state?.lines ?? [];
  const interim = state?.interim ?? "";
  const lang = state?.lang;
  return (
    <section className="panel captions" aria-labelledby="captions-heading">
      <PanelHeader id="captions-heading" title={agent.label} health={agent.health} />
      <ScrollLog
        label={`${agent.label}, newest last`}
        lang={lang}
        dir={dirOf(lang)}
        count={lines.length}
        footer={
          interim ? (
            <p className="line interim" aria-hidden="true">
              {interim}
              <span className="interim-mark">…</span>
            </p>
          ) : undefined
        }
      >
        {lines.length === 0 && !interim ? <p className="muted">Waiting for the speaker…</p> : null}
        {lines.map((l) => (
          <p key={l.id} className="line">
            {l.text}
          </p>
        ))}
      </ScrollLog>
    </section>
  );
}

// --- translation ---------------------------------------------------------------------------------

export function TranslationPanel({ agent }: { agent: AgentView }) {
  const state = stateOf(agent, "translation");
  const lines = state?.lines ?? [];
  const lang = state?.lang ?? agent.lang;
  const headingId = useId();
  return (
    <section className="panel translation" aria-labelledby={headingId}>
      <PanelHeader id={headingId} title={trackLabel(agent)} health={agent.health} />
      <ScrollLog label={`${trackLabel(agent)}, newest last`} lang={lang} dir={dirOf(lang)} count={lines.length}>
        {lines.length === 0 ? <p className="muted">Waiting for the first line…</p> : null}
        {lines.map((l) => (
          <p key={l.id} className="line">
            {l.text}
          </p>
        ))}
      </ScrollLog>
    </section>
  );
}

// --- slide descriptions --------------------------------------------------------------------------

export function SlidesPanel({ agent }: { agent: AgentView }) {
  const state = stateOf(agent, "slides");
  const slides = state?.slides ?? [];
  const lang = state?.lang;
  const speech = useSpeech();
  const [autoRead, setAutoRead] = useState(false);
  const seen = useRef<number | undefined>(undefined);
  const newest = slides[slides.length - 1];

  useEffect(() => {
    if (!newest) return;
    const first = seen.current === undefined;
    if (seen.current === newest.id) return;
    seen.current = newest.id;
    if (!first && autoRead) speech.speak(newest.description, lang);
  }, [newest, autoRead, lang, speech]);

  return (
    <section className="panel slides" aria-labelledby="slides-heading">
      <PanelHeader id="slides-heading" title={agent.label} health={agent.health} />
      {speech.supported ? (
        <div className="slides-controls">
          <Switch
            label="Read new slides aloud"
            description="Uses your device's voice. Screen readers announce new slides anyway."
            value={autoRead}
            onChange={(checked) => {
              setAutoRead(checked);
              if (checked) speech.unlock();
              else speech.cancel();
            }}
          />
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {newest ? `Slide ${newest.id + 1}: ${newest.description}` : ""}
      </div>
      {slides.length === 0 ? <p className="muted">No slide described yet.</p> : null}
      <ol className="slide-list" lang={lang} dir={dirOf(lang)} reversed>
        {[...slides].reverse().map((s) => (
          <li key={s.id} className="slide-card">
            <div className="slide-card-head">
              <Badge label={`Slide ${s.id + 1}`} variant={s.id === newest?.id ? "info" : "neutral"} />
              {speech.supported ? (
                <Button
                  label="Read aloud"
                  size="sm"
                  variant="ghost"
                  onClick={() => speech.speak(s.description, lang)}
                  aria-label={`Read slide ${s.id + 1} aloud`}
                />
              ) : null}
            </div>
            <p>{s.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// --- chapters, glossary, recap -------------------------------------------------------------------

export function OutlinePanel({ agent, origin }: { agent: AgentView; origin: number | undefined }) {
  const state = stateOf(agent, "outline");
  const lang = state?.lang;
  const chapters = state?.chapters ?? [];
  const glossary = state?.glossary ?? [];
  const recap = state?.recap ?? "";
  return (
    <section className="panel outline" aria-labelledby="outline-heading" lang={lang} dir={dirOf(lang)}>
      <PanelHeader id="outline-heading" title={agent.label} health={agent.health} />
      {recap ? (
        <>
          <h3 className="sub-title">So far</h3>
          <p className="recap">{recap}</p>
        </>
      ) : null}
      <h3 className="sub-title">Chapters</h3>
      {chapters.length === 0 ? (
        <p className="muted">No chapters yet.</p>
      ) : (
        <ol className="chapter-list">
          {chapters.map((c) => (
            <li key={c.id}>
              <span className="chapter-time">{formatMediaTime(c.start_ms - (origin ?? 0))}</span>{" "}
              <strong>{c.title}</strong>
              <p>{c.summary}</p>
            </li>
          ))}
        </ol>
      )}
      <h3 className="sub-title">Glossary</h3>
      {glossary.length === 0 ? (
        <p className="muted">No terms yet.</p>
      ) : (
        <dl className="glossary">
          {glossary.map((g) => (
            <div key={g.term}>
              <dt>{g.term}</dt>
              <dd>{g.definition}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function PanelHeader({ id, title, health }: { id: string; title: string; health: Health }) {
  return (
    <div className="panel-head">
      <h2 id={id} className="panel-title">
        {title}
      </h2>
      <HealthDot health={health} />
    </div>
  );
}

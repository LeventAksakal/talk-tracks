import { agentsPrefix, STALE_AFTER_MS, STATE_TRACK, ROOT } from "../contracts/names";
import type { LegacyEnvelope as Envelope, StateKind } from "../contracts/types";
import { parseLegacyEnvelope as parseEnvelope } from "../contracts/validate";
import type { Closable, ConnectionStatus, Transport } from "../transport/types";
import { newestInstance, parseAgentPath, SnapshotFilter } from "./follow";

/** One state snapshot as it arrived. Kept per agent track so a later rewind can scrub them. */
export interface Snapshot {
  envelope: Envelope;
  receivedAt: number;
}

export type Health = "waiting" | "live" | "stale" | "gone";

export interface AgentView {
  /** Stable agent name, e.g. captions or translate-tr. */
  name: string;
  label: string;
  model: string | undefined;
  kind: StateKind | undefined;
  lang: string | undefined;
  /** The instance followed: the newest numeric one announced. */
  instance: string | undefined;
  /** Every instance currently announced. */
  instances: readonly string[];
  /** Whether this viewer subscribes to the agent's track. */
  subscribed: boolean;
  health: Health;
  lastObjectAt: number | undefined;
  /** The newest state of the followed instance (kept after unsubscribing or going stale). */
  latest: Snapshot | undefined;
  historyLength: number;
  /** Cumulative cost over every instance seen, in USD. */
  costUsd: number;
  requests: number;
}

export interface RoomView {
  room: string;
  status: ConnectionStatus;
  agents: readonly AgentView[];
  /** Whether the speaker's broadcast (talk/<room>/teacher) is announced. */
  teacherLive: boolean;
  slidesLive: boolean;
}

export interface RoomStoreOptions {
  now?: () => number;
  staleAfterMs?: number;
  /** Which agents to subscribe to when they first appear (default: every agent). */
  subscribeByDefault?: (agent: string) => boolean;
  /** Most snapshots kept per agent; older ones are thinned out, not dropped wholesale. */
  maxHistory?: number;
  /** Interval of the staleness check, ms. */
  tickMs?: number;
}

interface AgentEntry {
  name: string;
  instances: Set<string>;
  followed: string | undefined;
  subscribed: boolean;
  subscription: Closable | undefined;
  subscribedTo: string | undefined;
  filter: SnapshotFilter;
  lastObjectAt: number | undefined;
  latest: Snapshot | undefined;
  history: Snapshot[];
  label: string | undefined;
  model: string | undefined;
  kind: StateKind | undefined;
  lang: string | undefined;
  costByInstance: Map<string, number>;
  requestsByInstance: Map<string, number>;
  everLive: boolean;
}

const KIND_ORDER: Record<string, number> = { captions: 0, translation: 1, slides: 2, outline: 3 };

/** What the agent name says about its kind and language before any snapshot arrives. */
export function guessFromName(name: string): { kind: StateKind | undefined; lang: string | undefined; label: string } {
  if (name === "captions") return { kind: "captions", lang: undefined, label: "Captions" };
  const tr = /^translate-([a-z]{2,3}(?:-[a-z0-9]+)?)$/i.exec(name);
  if (tr?.[1]) return { kind: "translation", lang: tr[1], label: `Translation (${tr[1]})` };
  if (name === "describe") return { kind: "slides", lang: undefined, label: "Slide descriptions" };
  if (name === "chapters") return { kind: "outline", lang: undefined, label: "Chapters, glossary and recap" };
  return { kind: undefined, lang: undefined, label: name };
}

/**
 * Everything a viewer or the speaker console knows about a room: which agents exist, which
 * instance of each to follow, whether it is alive, and every snapshot received. Built on the
 * Transport interface only; plug it into React with useSyncExternalStore.
 */
export class RoomStore {
  readonly room: string;
  #transport: Transport;
  #now: () => number;
  #staleAfter: number;
  #maxHistory: number;
  #subscribeByDefault: (agent: string) => boolean;
  #agents = new Map<string, AgentEntry>();
  #teacherLive = false;
  #slidesLive = false;
  #status: ConnectionStatus;
  #listeners = new Set<() => void>();
  #view: RoomView;
  #closables: Closable[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #healthKey = "";

  constructor(transport: Transport, room: string, options: RoomStoreOptions = {}) {
    this.room = room;
    this.#transport = transport;
    this.#now = options.now ?? Date.now;
    this.#staleAfter = options.staleAfterMs ?? STALE_AFTER_MS;
    this.#maxHistory = options.maxHistory ?? 3_000;
    this.#subscribeByDefault = options.subscribeByDefault ?? (() => true);
    this.#status = transport.status();
    this.#view = this.#buildView();

    this.#closables.push(
      transport.onStatus((status) => {
        this.#status = status;
        this.#changed();
      }),
    );
    const roomPrefix = `${ROOT}/${room}`;
    const agentsRel = agentsPrefix(room).slice(roomPrefix.length + 1);
    this.#closables.push(
      transport.announced(roomPrefix, ({ path, active }) => {
        if (path === "teacher") {
          this.#teacherLive = active;
          this.#changed();
        } else if (path === "slides") {
          this.#slidesLive = active;
          this.#changed();
        } else if (path.startsWith(`${agentsRel}/`)) {
          const parsed = parseAgentPath(path.slice(agentsRel.length + 1));
          if (parsed) this.#onAgentAnnounce(parsed.agent, parsed.instance, active);
        }
      }),
    );
    const tickMs = options.tickMs ?? 1_000;
    if (tickMs > 0) this.#timer = setInterval(() => this.tick(), tickMs);
  }

  // --- React glue --------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): RoomView => this.#view;

  // --- commands ----------------------------------------------------------------------------------

  /** Subscribe to (true) or drop (false) an agent's track. */
  setSubscribed(agent: string, subscribed: boolean): void {
    const entry = this.#agents.get(agent);
    if (!entry || entry.subscribed === subscribed) return;
    entry.subscribed = subscribed;
    this.#sync(entry);
    this.#changed();
  }

  /** Every snapshot received from an agent, oldest first, with its arrival time. */
  history(agent: string): readonly Snapshot[] {
    return this.#agents.get(agent)?.history ?? [];
  }

  /** Re-evaluate staleness (called on a timer; tests call it directly). */
  tick(): void {
    const key = this.#view.agents.map((a) => `${a.name}:${this.#health(this.#agents.get(a.name)!)}`).join(",");
    if (key !== this.#healthKey) this.#changed();
  }

  close(): void {
    clearInterval(this.#timer);
    for (const c of this.#closables) c.close();
    for (const entry of this.#agents.values()) entry.subscription?.close();
    this.#listeners.clear();
  }

  // --- internals ---------------------------------------------------------------------------------

  #entry(name: string): AgentEntry {
    let entry = this.#agents.get(name);
    if (!entry) {
      const guess = guessFromName(name);
      entry = {
        name,
        instances: new Set(),
        followed: undefined,
        subscribed: this.#subscribeByDefault(name),
        subscription: undefined,
        subscribedTo: undefined,
        filter: new SnapshotFilter(),
        lastObjectAt: undefined,
        latest: undefined,
        history: [],
        label: undefined,
        model: undefined,
        kind: guess.kind,
        lang: guess.lang,
        costByInstance: new Map(),
        requestsByInstance: new Map(),
        everLive: false,
      };
      this.#agents.set(name, entry);
    }
    return entry;
  }

  #onAgentAnnounce(agent: string, instance: string, active: boolean): void {
    const entry = this.#entry(agent);
    if (active) entry.instances.add(instance);
    else entry.instances.delete(instance);
    const next = newestInstance(entry.instances);
    if (next !== undefined && next !== entry.followed) {
      entry.followed = next;
      entry.lastObjectAt = undefined;
    }
    this.#sync(entry);
    this.#changed();
  }

  /** Make the subscription match: subscribed and an instance to follow, or nothing. */
  #sync(entry: AgentEntry): void {
    const want = entry.subscribed && entry.followed !== undefined && entry.instances.has(entry.followed);
    const target = want ? entry.followed : undefined;
    if (target === entry.subscribedTo) return;
    entry.subscription?.close();
    entry.subscription = undefined;
    entry.subscribedTo = target;
    if (target === undefined) return;
    const path = `${agentsPrefix(this.room)}/${entry.name}/${target}`;
    entry.subscription = this.#transport.subscribe(path, STATE_TRACK, (object) => {
      const parsed = parseEnvelope(object.payload);
      if (!parsed.ok) {
        console.warn(`dropping an object from ${path} that does not match the contract: ${parsed.error}`);
        return;
      }
      this.#onEnvelope(entry, parsed.value, object.receivedAt);
    });
  }

  #onEnvelope(entry: AgentEntry, envelope: Envelope, receivedAt: number): void {
    const verdict = entry.filter.accept(envelope, entry.followed);
    if (verdict === "other") return;
    entry.lastObjectAt = this.#now();
    entry.everLive = true;
    entry.costByInstance.set(envelope.instance, envelope.usage.cost_usd ?? 0);
    entry.requestsByInstance.set(envelope.instance, envelope.usage.requests ?? 0);
    entry.label = envelope.agent.label;
    entry.model = envelope.agent.model;
    entry.kind = envelope.state.kind;
    entry.lang = envelope.state.lang;
    if (verdict === "new") {
      const snapshot = { envelope, receivedAt };
      entry.latest = snapshot;
      entry.history.push(snapshot);
      if (entry.history.length > this.#maxHistory) entry.history = thin(entry.history);
    }
    this.#changed();
  }

  #health(entry: AgentEntry): Health {
    if (entry.followed === undefined || !entry.instances.has(entry.followed))
      return entry.everLive ? "gone" : "waiting";
    if (entry.lastObjectAt === undefined) return entry.subscribed ? "waiting" : entry.everLive ? "stale" : "waiting";
    return this.#now() - entry.lastObjectAt > this.#staleAfter ? "stale" : "live";
  }

  #changed(): void {
    this.#view = this.#buildView();
    this.#healthKey = this.#view.agents.map((a) => `${a.name}:${a.health}`).join(",");
    for (const fn of [...this.#listeners]) fn();
  }

  #buildView(): RoomView {
    const agents = [...this.#agents.values()]
      .map((e): AgentView => {
        const guess = guessFromName(e.name);
        return {
          name: e.name,
          label: e.label ?? guess.label,
          model: e.model,
          kind: e.kind,
          lang: e.lang,
          instance: e.followed,
          instances: [...e.instances].sort(),
          subscribed: e.subscribed,
          health: this.#health(e),
          lastObjectAt: e.lastObjectAt,
          latest: e.latest,
          historyLength: e.history.length,
          costUsd: sum(e.costByInstance.values()),
          requests: sum(e.requestsByInstance.values()),
        };
      })
      .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    return {
      room: this.room,
      status: this.#status,
      agents,
      teacherLive: this.#teacherLive,
      slidesLive: this.#slidesLive,
    };
  }
}

function order(agent: AgentView): number {
  return agent.kind ? (KIND_ORDER[agent.kind] ?? 9) : 9;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/** Halve the older half of the history, so the timeline stays covered while memory stays bounded. */
function thin(history: Snapshot[]): Snapshot[] {
  const half = Math.floor(history.length / 2);
  return [...history.slice(0, half).filter((_, i) => i % 2 === 0), ...history.slice(half)];
}

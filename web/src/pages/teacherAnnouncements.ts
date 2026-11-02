// The hub's own relay connection: announcements only, narrowed to the speaker broadcasts.
//
// A MoqTransport's origin takes in every broadcast the relay announces (each room has a dozen: slides, catalog,
// chat, stats, every agent), routes each one and matches it against every reader. The hub only asks which rooms
// have a speaker on air, so its origin is scoped to `talk/*/teacher`: the rest is dropped as it arrives, before it
// is routed. Loaded as its own chunk after the hub's first paint (it pulls in @moq/net).

import * as Moq from "@moq/net";
import { ROOT } from "../contracts/names";
import type { AnnounceEvent, Closable, ConnectionStatus } from "../transport/types";
import type { AnnounceSource } from "./liveRooms";

/** The only broadcasts the hub hears of. */
export const TEACHER_PATTERN = `${ROOT}/*/teacher`;

export class TeacherAnnouncements implements AnnounceSource, Closable {
  readonly #root = new Moq.Origin.Producer();
  readonly #origin: Moq.Origin.Producer;
  readonly #connection: Moq.Connection;

  constructor(url: URL) {
    this.#origin = this.#root.scope(Moq.Path.empty(), new Moq.Path.Patterns([Moq.Path.Pattern.parse(TEACHER_PATTERN)]));
    this.#connection = new Moq.Connection({
      url,
      consume: this.#origin,
      websocket: { enabled: true },
      delay: { timeout: Moq.Time.Milli(0) },
    });
  }

  announced(prefix: string, onEvent: (event: AnnounceEvent) => void): Closable {
    const base = Moq.Path.from(prefix);
    const consumer = this.#origin.announced(Moq.Path.Pattern.subtree(base));
    let closed = false;
    void (async () => {
      try {
        for (;;) {
          const update = await consumer.next();
          if (!update || closed) return;
          const rel = Moq.Path.stripPrefix(base, update.prefix);
          if (rel !== null) onEvent({ path: rel, active: Moq.Announce.isActive(update.kind) });
        }
      } catch {
        // The origin closed: the hub is gone.
      }
    })();
    return {
      close: () => {
        closed = true;
        consumer.close();
      },
    };
  }

  status(): ConnectionStatus {
    if (this.#connection.error.peek()) return "failed";
    return this.#connection.status.peek();
  }

  onStatus(listener: (status: ConnectionStatus) => void): Closable {
    const emit = () => listener(this.status());
    const a = this.#connection.status.subscribe(emit);
    const b = this.#connection.error.subscribe(emit);
    return {
      close: () => {
        a();
        b();
      },
    };
  }

  close(): void {
    this.#connection.close();
    this.#root.close();
  }
}

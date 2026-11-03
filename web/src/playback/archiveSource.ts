// A recording room's AI track slices, read from the archive over HTTP before asking the relay (decision 0035). A
// recording is ended from the start: its captions and other baked tracks are finished `.slice` files on disk, and a
// translation slice someone already back-filled is too. Reading those files costs nothing and does not depend on the
// relay answering a FETCH in time; only a slice the archive does not have (a translation nobody made yet) goes to
// the relay, whose FETCH wakes the agent to back-fill it.

import { ROOT } from "../contracts/names";
import type { AnnounceEvent, Closable } from "../transport/types";
import { type FetchOptions, type GroupObject, type HistorySource, type LiveOptions } from "./source";

/** Where the archive is served (wiki/howto/archive.md). */
export const ARCHIVE_BASE = "/archive";

type Fetch = (url: string, init: { signal?: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "text">>;

/**
 * The archive file of a group of `talk/<room>/agents/<agent>`'s `track`, or undefined for any other path:
 * `<base>/<room>/agents/<agent>/<track>/<group, 8 digits>.slice`.
 */
export function sliceUrl(path: string, track: string, group: number, base = ARCHIVE_BASE): string | undefined {
  const m = new RegExp(`^${ROOT}/([^/]+)/agents/([^/]+)$`).exec(path);
  if (!m || group < 0 || !Number.isInteger(group)) return undefined;
  return `${base}/${m[1]}/agents/${m[2]}/${track}/${String(group).padStart(8, "0")}.slice`;
}

/**
 * A `.slice` file's object payloads in order, as a FETCH returns them (`talk_tracks.archive.slices`): one JSON line per
 * object, `{"o": index, "t": text}` or `{"o": index, "b": base64}`; a status line (`"st"`, End of Group) is no object.
 */
export function parseSliceFile(text: string): Uint8Array[] {
  const objects: { o: number; payload: Uint8Array }[] = [];
  const encoder = new TextEncoder();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { o?: unknown; t?: unknown; b?: unknown; st?: unknown };
    if (typeof r.o !== "number") throw new Error("not a slice file line");
    if (r.st !== undefined && r.st !== 0) continue;
    const payload =
      typeof r.t === "string"
        ? encoder.encode(r.t)
        : typeof r.b === "string"
          ? Uint8Array.from(atob(r.b), (c) => c.charCodeAt(0))
          : new Uint8Array();
    objects.push({ o: r.o, payload });
  }
  return objects.sort((a, b) => a.o - b.o).map((r) => r.payload);
}

export class ArchiveFirstSource implements HistorySource {
  #inner: HistorySource;
  #fetch: Fetch;
  #base: string;

  constructor(inner: HistorySource, options: { fetch?: Fetch; base?: string } = {}) {
    this.#inner = inner;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#base = options.base ?? ARCHIVE_BASE;
  }

  announced(prefix: string, onEvent: (event: AnnounceEvent) => void): Closable {
    return this.#inner.announced(prefix, onEvent);
  }

  subscribe(path: string, track: string, onObject: (object: GroupObject) => void, options: LiveOptions): Closable {
    return this.#inner.subscribe(path, track, onObject, options);
  }

  async fetchGroup(path: string, track: string, group: number, options: FetchOptions): Promise<Uint8Array[]> {
    const url = sliceUrl(path, track, group, this.#base);
    if (url) {
      try {
        const res = await this.#fetch(url, { signal: options.signal });
        if (res.ok) return parseSliceFile(await res.text());
      } catch {
        // A broken file or a failed read: the relay may still have it (unless the FETCH was called off).
        options.signal?.throwIfAborted();
      }
    }
    return this.#inner.fetchGroup(path, track, group, options);
  }
}

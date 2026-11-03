import { describe, expect, it, vi } from "vitest";
import { ArchiveFirstSource, parseSliceFile, sliceUrl } from "./archiveSource";
import type { HistorySource } from "./source";

const text = (payloads: Uint8Array[]) => payloads.map((p) => new TextDecoder().decode(p));

const relay = (objects: string[] = ["relay"]): HistorySource => ({
  announced: () => ({ close: () => {} }),
  subscribe: () => ({ close: () => {} }),
  fetchGroup: vi.fn(async () => objects.map((o) => new TextEncoder().encode(o))),
});

const file = ['{"o":0,"t":"[]"}', '{"o":1,"t":"{\\"a\\":1}","p":224}', '{"o":2,"st":3}', ""].join("\n");

describe("a recording's slices from the archive", () => {
  it("reads an agent track's slice file, in object order, without its End of Group line", () => {
    expect(sliceUrl("talk/dataviz-recording/agents/captions", "items", 142)).toBe(
      "/archive/dataviz-recording/agents/captions/items/00000142.slice",
    );
    expect(sliceUrl("talk/r/catalog", "room", 1)).toBeUndefined();
    expect(text(parseSliceFile(file))).toEqual(["[]", '{"a":1}']);
    expect(text(parseSliceFile('{"o":0,"b":"aGk="}\n'))).toEqual(["hi"]);
  });

  it("answers a FETCH from the archive when it has the slice, and never asks the relay then", async () => {
    const inner = relay();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => file }));
    const source = new ArchiveFirstSource(inner, { fetch });
    const got = await source.fetchGroup("talk/r-recording/agents/captions", "items", 3, { priority: 1 });
    expect(text(got)).toEqual(["[]", '{"a":1}']);
    expect(inner.fetchGroup).not.toHaveBeenCalled();
  });

  it("asks the relay for a slice the archive lacks (a translation nobody made yet), or cannot read", async () => {
    for (const answer of [
      async () => ({ ok: false, status: 404, text: async () => "" }),
      async () => ({ ok: true, status: 200, text: async () => "not json" }),
      async () => Promise.reject(new TypeError("network")),
    ]) {
      const inner = relay();
      const source = new ArchiveFirstSource(inner, { fetch: vi.fn(answer) });
      const got = await source.fetchGroup("talk/r-recording/agents/translate-de", "items", 3, { priority: 1 });
      expect(text(got)).toEqual(["relay"]);
      expect(inner.fetchGroup).toHaveBeenCalledOnce();
    }
  });

  it("stops at a FETCH that was called off", async () => {
    const inner = relay();
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const source = new ArchiveFirstSource(inner, { fetch });
    await expect(
      source.fetchGroup("talk/r/agents/captions", "items", 0, { priority: 1, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(inner.fetchGroup).not.toHaveBeenCalled();
  });
});

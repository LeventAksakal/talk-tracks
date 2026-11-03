import * as Moq from "@moq/net";
import { describe, expect, it, vi } from "vitest";
import { consumeScope, MoqTransport } from "./moq";

describe("the close error @moq/net logs", () => {
  it("is a warning once the page is being left, an error otherwise", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new MoqTransport({ url: new URL("http://localhost:1/") });
    try {
      console.error("fatal error running connection", new Error("x"));
      expect(error).toHaveBeenCalledTimes(1);
      dispatchEvent(new Event("pagehide"));
      console.error("fatal error running connection", new Error("x"));
      console.error("something else");
      expect(error).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      dispatchEvent(new Event("pageshow"));
      console.error("fatal error running connection", new Error("x"));
      expect(error).toHaveBeenCalledTimes(3);
    } finally {
      transport.close();
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

/** The prefixes `origin` announces within 50 ms. */
async function announcedBy(origin: Moq.Origin.Producer): Promise<string[]> {
  const consumer = origin.announced();
  const seen: string[] = [];
  const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), 50));
  for (;;) {
    const next = await Promise.race([consumer.next(), timeout]);
    if (!next) break;
    seen.push(String(next.prefix));
  }
  consumer.close();
  return seen.sort();
}

describe("consumeScope", () => {
  it("is the whole origin when no scope is set", () => {
    const origin = new Moq.Origin.Producer();
    expect(consumeScope(origin)).toBe(origin);
  });

  it("narrows what a connection reads to the room's prefix, other rooms left out", async () => {
    const origin = new Moq.Origin.Producer();
    for (const path of ["talk/dataviz/teacher", "talk/dataviz-recording/teacher", "talk/virus/teacher"]) {
      const b = origin.createBroadcast(Moq.Path.from(path));
      b.createTrack("t");
      b.announce();
    }
    expect(await announcedBy(origin)).toHaveLength(3);
    expect(await announcedBy(consumeScope(origin, "talk/dataviz"))).toEqual(["talk/dataviz/teacher"]);
  });
});

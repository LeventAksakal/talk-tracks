import * as Moq from "@moq/net";
import { describe, expect, it } from "vitest";
import { consumeScope } from "./moq";

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

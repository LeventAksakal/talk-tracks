import { beforeEach, describe, expect, it } from "vitest";
import { forgetToken, speakerToken } from "./savedToken";

const NOW = Date.parse("2026-11-02T12:00:00Z");

/** A speaker token as the room service signs it (the signature is the relay's business, not checked here). */
function token(room: string, expiresMs: number): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const claims = { publish: [`talk/${room}/slides`, `talk/${room}/teacher`], subscribe: [`talk/${room}/**`] };
  return `${b64({ alg: "ES256" })}.${b64({ ...claims, exp: expiresMs / 1000 })}.sig`;
}

describe("the speaker link across reloads", () => {
  beforeEach(() => localStorage.clear());

  it("opens the console again without the token in the link, in the same browser, for that room only", () => {
    const t = token("physics-101", NOW + 3_600_000);
    expect(speakerToken("physics-101", t, NOW)).toBe(t);
    expect(speakerToken("physics-101", undefined, NOW)).toBe(t); // reloaded without ?token=
    expect(speakerToken("chemistry", undefined, NOW)).toBeUndefined();
  });

  it("forgets the link when the talk ends", () => {
    const t = token("physics-101", NOW + 3_600_000);
    speakerToken("physics-101", t, NOW);
    forgetToken("physics-101");
    expect(speakerToken("physics-101", undefined, NOW)).toBeUndefined();
  });

  it("never uses a kept token that expired, and a new link replaces the kept one", () => {
    const old = token("physics-101", NOW + 1_000);
    speakerToken("physics-101", old, NOW);
    expect(speakerToken("physics-101", undefined, NOW + 2_000)).toBeUndefined();

    const fresh = token("physics-101", NOW + 3_600_000);
    speakerToken("physics-101", old, NOW);
    speakerToken("physics-101", fresh, NOW);
    expect(speakerToken("physics-101", undefined, NOW)).toBe(fresh);
  });
});

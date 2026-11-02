import { describe, expect, it } from "vitest";
import { LaserTrail, TRAIL_MS } from "./laser";

describe("the console's laser trail", () => {
  it("keeps the positions of the last TRAIL_MS, so the trail fades out once the laser stops or goes off", () => {
    const trail = new LaserTrail();
    trail.add(0.1, 0.1, 0);
    trail.add(0.2, 0.1, 100);
    trail.add(0.3, 0.1, 200);
    expect(trail.points(200).map((p) => p.x)).toEqual([0.1, 0.2, 0.3]);
    expect(trail.points(100 + TRAIL_MS).map((p) => p.x)).toEqual([0.2, 0.3]);
    // Held still, the laser renews its one position instead of piling up copies.
    trail.add(0.3, 0.1, 300);
    expect(trail.points(300 + TRAIL_MS).map((p) => p.x)).toEqual([0.3]);
    expect(trail.points(301 + TRAIL_MS)).toEqual([]);
  });
});

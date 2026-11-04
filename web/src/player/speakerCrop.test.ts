import { describe, expect, it } from "vitest";
import { DEMO_ROOMS, recordingRoom } from "../pages/demoRooms";
import { framing } from "./CameraSurface";
import { cropSpanAt, speakerAspect, speakerAt, speakerCropsFor, speakerFor } from "./speakerCrop";

const at = (room: string, ms: number | undefined) => {
  const crops = speakerCropsFor(room)!;
  return speakerAt(crops, cropSpanAt(crops, ms));
};

describe("the speaker crop of a demo talk's produced video", () => {
  it("covers every demo talk, live and recorded, and no other room", () => {
    for (const { room } of DEMO_ROOMS) {
      expect(speakerCropsFor(room)).toBeDefined();
      expect(speakerCropsFor(recordingRoom(room))).toBe(speakerCropsFor(room));
    }
    expect(speakerCropsFor("live")).toBeUndefined();
    expect(speakerCropsFor("toString")).toBeUndefined();
  });

  it("is back to back from 00:00, and every rectangle lies inside the frame", () => {
    for (const { room } of DEMO_ROOMS) {
      const { frame, spans } = speakerCropsFor(room)!;
      expect(spans[0]![0]).toBe(0);
      spans.forEach(([from, to, rect], i) => {
        expect(to).toBeGreaterThan(from);
        if (i > 0) expect(from).toBe(spans[i - 1]![1]);
        if (!rect) return;
        const [x, y, w, h] = rect;
        expect(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= frame[0] && y + h <= frame[1]).toBe(true);
      });
      // One shape per talk: the tile does not change shape when the feed cuts.
      const shapes = new Set(spans.flatMap(([, , r]) => (r ? [(r[2] / r[3]).toFixed(2)] : [])));
      expect(shapes.size).toBe(1);
    }
  });

  it("shows the speaker's box in the corner while the slide has the frame", () => {
    // "A Brief History of the QR Code": the slide with the speaker bottom right around 2:20.
    const s = at("qrcode-recording", 140_000)!;
    expect(s.off).toBe(false);
    const [x, y] = s.region;
    expect(x).toBeGreaterThan(0.75);
    expect(y).toBeGreaterThan(0.5);
    // The tile takes the box's shape, and the picture is cut to it, never stretched.
    const { aspect } = framing(16 / 9, s.region);
    expect(aspect).toBeCloseTo(278 / 313, 2);
    expect(aspect).toBeCloseTo(speakerAspect(speakerCropsFor("qrcode")!)!, 2);
  });

  it("follows the feed's cut to the stage camera: the speaker, full height, in the same shape", () => {
    const s = at("qrcode", 215_000)!;
    expect(s.off).toBe(false);
    expect(s.region[1]).toBe(0);
    expect(s.region[3]).toBe(1);
    expect(framing(16 / 9, s.region).aspect).toBeCloseTo(278 / 313, 2);
  });

  it("is off camera on a full-frame slide, keeping the tile's shape", () => {
    // "You Are Part Virus" zooms on a slide around 1:30; the QR talk shows its slides full frame for long stretches.
    for (const [room, ms] of [
      ["virus", 90_000],
      ["qrcode", 40_000],
      ["rsa-recording", 20_000],
    ] as const) {
      const s = at(room, ms)!;
      expect(s.off).toBe(true);
      expect(framing(16 / 9, s.region).aspect).toBeCloseTo(speakerAspect(speakerCropsFor(room)!)!, 2);
    }
    expect(at("virus", 120_000)!.off).toBe(false);
  });

  it("holds the first span before 00:00 and the last after the end, and knows nothing without a time", () => {
    const crops = speakerCropsFor("dataviz")!;
    expect(cropSpanAt(crops, -5000)).toBe(0);
    expect(cropSpanAt(crops, 10 * 3600_000)).toBe(crops.spans.length - 1);
    expect(cropSpanAt(crops, undefined)).toBe(-1);
    expect(speakerAt(crops, -1)).toBeUndefined();
  });

  it("opens on the speaker's box before the time is known, even in a talk that starts on a slide", () => {
    for (const room of ["qrcode", "rsa"]) {
      const crops = speakerCropsFor(room)!;
      expect(speakerFor(crops, 0)!.off).toBe(true);
      const unknown = speakerFor(crops, undefined)!;
      expect(unknown.off).toBe(false);
      expect(framing(16 / 9, unknown.region).aspect).toBeCloseTo(speakerAspect(crops)!, 2);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { RoomTt } from "../contracts/types";
import { parseRoomCatalog } from "../contracts/validate";
import { cameraRegion, framing } from "./CameraSurface";
import { slideAspect } from "./SlideSurface";

const tt = (regions: unknown) => ({ E: 0, shift: {}, regions }) as unknown as RoomTt;
const frac = (css: string | number | undefined) => parseFloat(String(css)) / 100;

describe("the camera tile of a composed lecture video", () => {
  const webcam = [0.776, 0.543, 0.216, 0.433] as const; // the EMF layout: the speaker bottom right

  it("shows exactly the webcam inset, in its own shape", () => {
    const { aspect, media } = framing(16 / 9, cameraRegion(tt({ slides: [0, 0, 0.77, 0.77], camera: webcam })));
    const [x, y, w, h] = webcam;
    expect(aspect).toBeCloseTo(((16 / 9) * w) / h, 6);
    // The picture's box, in fractions of the tile: the region's corners land on the tile's corners.
    const left = frac(media?.left);
    const top = frac(media?.top);
    const width = frac(media?.width);
    const height = frac(media?.height);
    expect(left + x * width).toBeCloseTo(0, 6);
    expect(top + y * height).toBeCloseTo(0, 6);
    expect(left + (x + w) * width).toBeCloseTo(1, 6);
    expect(top + (y + h) * height).toBeCloseTo(1, 6);
    // and the picture keeps the frame's shape, so it is cut, never stretched
    expect((width * aspect) / height).toBeCloseTo(16 / 9, 6);
  });

  it("reads the region from a room catalog the player accepts", () => {
    const catalog = {
      tracks: [],
      tt: { E: 0, shift: {}, regions: { slides: [0.01, 0.01, 0.76, 0.76], camera: webcam } },
    };
    const parsed = parseRoomCatalog(JSON.stringify(catalog));
    expect(parsed.ok).toBe(true);
    expect(cameraRegion(parsed.ok ? parsed.value.tt : undefined)).toEqual(webcam);
    const outside = { ...catalog, tt: { ...catalog.tt, regions: { slides: [0, 0, 1.2, 1] } } };
    expect(parseRoomCatalog(JSON.stringify(outside)).ok).toBe(false);
  });

  it("shows the whole picture for a speaker's own camera or a broken region", () => {
    for (const regions of [undefined, null, { slides: [0, 0, 1, 1] }, { slides: [0, 0, 1, 1], camera: null }]) {
      expect(framing(4 / 3, cameraRegion(tt(regions)))).toEqual({ aspect: 4 / 3 });
    }
    for (const camera of [
      [0.5, 0.5, 0.6, 0.2],
      [0, 0, 0, 0.5],
      [0.1, 0.1, 0.2],
      ["0", 0, 0.5, 0.5],
    ]) {
      expect(cameraRegion(tt({ slides: [0, 0, 1, 1], camera }))).toBeUndefined();
    }
    expect(cameraRegion(undefined)).toBeUndefined();
  });
});

describe("the slide tile", () => {
  const picture = (width: number, height: number) => ({ image: { width, height } });

  it("takes the shape of the slide on screen, so the whole slide shows", () => {
    expect(slideAspect(picture(1024, 768), 16 / 9)).toBeCloseTo(4 / 3, 6);
    expect(slideAspect(picture(1280, 720))).toBeCloseTo(16 / 9, 6);
  });

  it("falls back to the deck's shape, then 16:9, until the picture is in", () => {
    expect(slideAspect(undefined, 1.6)).toBe(1.6);
    expect(slideAspect(picture(0, 0), 1.6)).toBe(1.6);
    expect(slideAspect(undefined)).toBeCloseTo(16 / 9, 6);
  });
});

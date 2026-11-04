import { describe, expect, it } from "vitest";
import { dropTarget, mainPicture } from "./Workspace";
import {
  close,
  dock,
  float,
  LAYOUT_KEY,
  moveFloat,
  open,
  parseLayout,
  preset,
  readLayout,
  resizeZone,
  resolve,
  setSplit,
  SIZE_LIMITS,
  toggle,
  visible,
  where,
  writeLayout,
} from "./layout";

const all = new Set(["slides", "camera", "chat", "transcript", "chapters", "discussion"]);

describe("the workspace layout", () => {
  it("opens on slides and camera side by side, the reading panels as tabs on the right", () => {
    const l = resolve(preset("grid"), all);
    expect(l.zones.centre.panels).toEqual(["slides", "camera"]);
    expect([...visible(l)].sort()).toEqual(["camera", "chat", "slides"]);
  });

  it("docks a panel on any side, in front, and takes it out of where it was", () => {
    const l = dock(preset("grid"), "chapters", "left");
    expect(where(l, "chapters")).toBe("left");
    expect(l.zones.right.panels).not.toContain("chapters");
    expect(l.zones.left.active).toBe("chapters");
    expect(visible(resolve(l, all)).has("chapters")).toBe(true);
  });

  it("floats a panel as a small window and docks it back", () => {
    let l = float(preset("grid"), "camera");
    expect(where(l, "camera")).toBe("floating");
    // Any picture floats as itself, beside the camera's window.
    const both = float(l, "slides");
    expect(both.floating.map((f) => f.id)).toEqual(["camera", "slides"]);
    expect(where(both, "slides")).toBe("floating");
    expect(l.zones.centre.panels).not.toContain("camera");
    l = moveFloat(l, { id: "camera", x: 5, y: -1, w: 0.3, h: 0.3 });
    const box = l.floating[0]!;
    expect(box.x).toBeLessThanOrEqual(1 - box.w);
    expect(box.y).toBe(0);
    l = dock(l, "camera", "bottom");
    expect(where(l, "camera")).toBe("bottom");
    expect(l.floating).toEqual([]);
  });

  it("closes a panel and reopens it where it was", () => {
    let l = dock(preset("grid"), "transcript", "bottom");
    l = close(l, "transcript");
    expect(where(l, "transcript")).toBeUndefined();
    l = open(l, "transcript");
    expect(where(l, "transcript")).toBe("bottom");
    expect(where(toggle(l, "transcript"), "transcript")).toBeUndefined();
  });

  it("shows a zone as tabs or side by side, and keeps sizes in bounds", () => {
    const l = setSplit(preset("grid"), "right", true);
    expect([...visible(resolve(l, all))]).toEqual(expect.arrayContaining(["chat", "transcript", "chapters"]));
    expect(resizeZone(l, "right", 5_000).size.right).toBe(SIZE_LIMITS.max);
  });

  it("has the three presets: camera floating over the slides, and chapters left for study", () => {
    expect(where(preset("focus"), "camera")).toBe("floating");
    const study = preset("study");
    expect(where(study, "chapters")).toBe("left");
    expect(where(study, "slides")).toBe("centre");
    expect(where(study, "chat")).toBe("right");
  });

  it("shows only the panels a room has, and never plays the talk in a window over an empty centre", () => {
    const camOnly = resolve(preset("focus"), new Set(["camera", "transcript"]));
    expect(camOnly.zones.centre.panels).toEqual(["camera"]);
    expect(camOnly.floating).toEqual([]);
    expect(camOnly.zones.right.active).toBe("transcript");
  });

  it("puts the subtitles over the centre's picture", () => {
    expect(mainPicture(resolve(preset("grid"), all))).toBe("slides");
    expect(mainPicture(resolve(close(preset("grid"), "slides"), all))).toBe("camera");
  });

  it("docks where a panel is dropped: the edges, the centre, or floats it anywhere else", () => {
    expect(dropTarget(0.05, 0.5)).toBe("left");
    expect(dropTarget(0.95, 0.5)).toBe("right");
    expect(dropTarget(0.5, 0.9)).toBe("bottom");
    expect(dropTarget(0.5, 0.45)).toBe("centre");
    expect(dropTarget(0.2, 0.15)).toBeUndefined();
  });

  it("is kept per browser, and a broken or blocked store gives the default", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    const l = float(dock(preset("grid"), "chat", "left"), "camera");
    writeLayout(l, storage);
    expect(readLayout(storage)).toEqual(l);
    store.set(LAYOUT_KEY, "{not json");
    expect(readLayout(storage)).toEqual(preset("grid"));
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLayout(blocked)).toEqual(preset("grid"));
    expect(() =>
      writeLayout(l, {
        setItem: () => {
          throw new Error("full");
        },
      }),
    ).not.toThrow();
    // A panel listed twice keeps its first place.
    const twice = parseLayout(
      JSON.stringify({ ...l, zones: { ...l.zones, right: { ...l.zones.right, panels: ["chat", "transcript"] } } }),
    );
    expect(where(twice!, "chat")).toBe("left");
    expect(twice!.zones.right.panels).toEqual(["transcript"]);
  });
});

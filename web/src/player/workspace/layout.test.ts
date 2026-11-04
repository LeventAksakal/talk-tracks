import { describe, expect, it } from "vitest";
import { dropTarget, mainPicture } from "./Workspace";
import {
  applyView,
  close,
  dock,
  float,
  LAYOUT_KEY,
  moveFloat,
  open,
  parseLayout,
  preset,
  promote,
  readLayout,
  resizeZone,
  resolve,
  setSplit,
  showPanel,
  SIZE_LIMITS,
  toggle,
  togglePanel,
  visible,
  where,
  writeLayout,
} from "./layout";

const all = new Set(["slides", "camera", "chat", "transcript", "chapters", "discussion"]);
const withScreen = new Set([...all, "screen"]);

describe("the workspace layout", () => {
  it("opens in Auto: the slides large, the speaker beside them, no reading panel open", () => {
    const l = resolve(preset("auto"), all);
    expect(l.zones.centre.panels).toEqual(["slides", "camera"]);
    expect([...visible(l)].sort()).toEqual(["camera", "slides"]);
  });

  it("follows the talk in Auto: a shared screen large, the speaker first while no slide is up, the speaker alone", () => {
    expect(resolve(preset("auto"), withScreen).zones.centre.panels[0]).toBe("screen");
    expect(resolve(preset("auto"), all, new Set(["slides"])).zones.centre.panels).toEqual(["camera", "slides"]);
    expect(resolve(preset("auto"), new Set(["camera", "transcript"])).zones.centre.panels).toEqual(["camera"]);
  });

  it("arranges the streams as each view says, and leaves the reading panels where they are", () => {
    const base = showPanel(preset("auto"), "transcript");
    const tiled = resolve(applyView(base, "tiled"), withScreen);
    expect([...visible(tiled)].sort()).toEqual(["camera", "screen", "slides", "transcript"]);
    const spot = resolve(applyView(base, "spotlight"), withScreen);
    expect([...visible(spot)].filter((p) => ["slides", "screen", "camera"].includes(p))).toHaveLength(1);
    expect(where(spot, "transcript")).toBe("right");
    // A stream floated or docked aside comes back to the stage.
    const aside = dock(float(base, "camera"), "slides", "left");
    const side = applyView(aside, "sidebar");
    expect(where(side, "camera")).toBe("centre");
    expect(where(side, "slides")).toBe("centre");
    expect(side.floating).toEqual([]);
    expect(side.view).toBe("sidebar");
  });

  it("opens one reading panel at a time in the side card, and a second press closes it", () => {
    let l = showPanel(preset("auto"), "chat");
    l = showPanel(l, "transcript");
    expect(l.zones.right.panels).toEqual(["transcript"]);
    const on = visible(resolve(l, all));
    expect(where(togglePanel(l, "transcript", on), "transcript")).toBeUndefined();
    expect(where(togglePanel(l, "chapters", on), "chapters")).toBe("right");
  });

  it("stops the view once a stream is moved by hand; making one large leaves Auto for Sidebar", () => {
    expect(float(preset("tiled"), "camera").view).toBeUndefined();
    expect(showPanel(preset("tiled"), "chat").view).toBe("tiled");
    const big = promote(preset("auto"), "camera");
    expect(big.view).toBe("sidebar");
    expect(resolve(big, all).zones.centre.panels[0]).toBe("camera");
  });

  it("docks a panel on any side, in front, and takes it out of where it was", () => {
    const l = dock(showPanel(preset("tiled"), "chapters"), "chapters", "left");
    expect(where(l, "chapters")).toBe("left");
    expect(l.zones.right.panels).not.toContain("chapters");
    expect(l.zones.left.active).toBe("chapters");
    expect(visible(resolve(l, all)).has("chapters")).toBe(true);
  });

  it("floats a panel as a small window and docks it back", () => {
    let l = float(preset("tiled"), "camera");
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
    let l = dock(preset("tiled"), "transcript", "bottom");
    l = close(l, "transcript");
    expect(where(l, "transcript")).toBeUndefined();
    l = open(l, "transcript");
    expect(where(l, "transcript")).toBe("bottom");
    expect(where(toggle(l, "transcript"), "transcript")).toBeUndefined();
  });

  it("shows a zone as tabs or side by side, and keeps sizes in bounds", () => {
    const l = setSplit(dock(dock(preset("tiled"), "chat", "right"), "transcript", "right"), "right", true);
    expect([...visible(resolve(l, all))]).toEqual(expect.arrayContaining(["chat", "transcript"]));
    expect(resizeZone(l, "right", 5_000).size.right).toBe(SIZE_LIMITS.max);
  });

  it("never plays the talk in a window over an empty centre", () => {
    const camOnly = resolve(float(preset("tiled"), "camera"), new Set(["camera", "transcript"]));
    expect(camOnly.zones.centre.panels).toEqual(["camera"]);
    expect(camOnly.floating).toEqual([]);
  });

  it("puts the subtitles over the centre's picture", () => {
    expect(mainPicture(resolve(preset("tiled"), all))).toBe("slides");
    expect(mainPicture(resolve(close(preset("tiled"), "slides"), all))).toBe("camera");
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
    const l = float(dock(preset("tiled"), "chat", "left"), "camera");
    writeLayout(l, storage);
    expect(readLayout(storage)).toEqual(l);
    const picked = applyView(l, "spotlight");
    writeLayout(picked, storage);
    expect(readLayout(storage).view).toBe("spotlight");
    store.set(LAYOUT_KEY, "{not json");
    expect(readLayout(storage)).toEqual(preset("auto"));
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLayout(blocked)).toEqual(preset("auto"));
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

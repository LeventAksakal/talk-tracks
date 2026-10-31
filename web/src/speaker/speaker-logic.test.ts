import { describe, expect, it } from "vitest";
import { shapeEnd } from "../canvas/ink";
import type { Point, ShapeKind } from "../contracts/types";
import { strokesAt } from "./draw";
import { keyAction } from "./keys";
import { rangeBetween, spanBox, textRuns } from "./runs";
import { checkToken, patternCovers } from "./token";

/** A 960×540 pt page rendered 1600 px wide: PDF.js's viewport flips y and scales. */
const scale = 1600 / 960;
const viewport = { width: 1600, height: 900, scale, transform: [scale, 0, 0, -scale, 0, 900] };
const item = (str: string, x: number, y: number, size: number, width: number) => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
});

describe("text runs from a PDF page", () => {
  it("places each text item as a run with its box in fractions of the slide", () => {
    const runs = textRuns(
      [item("What a virus is", 48, 478, 40, 300), item("   ", 0, 0, 10, 5), item("Shell", 72, 380, 28, 70)],
      viewport,
    );
    expect(runs.map((r) => [r.id, r.text])).toEqual([
      ["t0", "What a virus is"],
      ["t1", "Shell"],
    ]);
    const b = runs[0]!.box;
    expect(b.x).toBeCloseTo(48 / 960, 3);
    expect(b.w).toBeCloseTo(300 / 960, 3);
    expect(b.h).toBeCloseTo(40 / 540, 3);
    // The box's top is the baseline minus the ascent.
    expect(b.y).toBeCloseTo((540 - 478 - 40 * 0.8) / 540, 3);
  });

  it("selects the text a drag crosses, and a whole word on a click", () => {
    const runs = textRuns(
      [item("Attach to the membrane", 72, 380, 28, 330), item("Inject the genome", 72, 324, 28, 250)],
      viewport,
    );
    const [a, b] = runs.map((r) => r.box);
    const mid = (r: typeof a) => r!.y + r!.h / 2;
    // From the start of the first line to after "Inject th" on the second.
    const upTo = spanBox(runs[1]!, 0, 9);
    expect(rangeBetween(runs, [a!.x, mid(a)], [upTo.x + upTo.w, mid(b)])).toEqual([
      { run: "t0" },
      { run: "t1", end: 9 },
    ]);
    // A click on "membrane" marks that word.
    const at = spanBox(runs[0]!, 15, 22);
    expect(rangeBetween(runs, [at.x + at.w / 2, mid(a)], [at.x + at.w / 2, mid(a)])).toEqual([
      { run: "t0", start: 14 },
    ]);
    // Away from any text: nothing.
    expect(rangeBetween(runs, [0.9, 0.9], [0.95, 0.95])).toBeNull();
  });

  it("selects to the end of the line when a drag runs past it, but not on a click beside it", () => {
    const runs = textRuns([item("Attach to the membrane", 72, 380, 28, 330)], viewport);
    const { x, y, w, h } = runs[0]!.box;
    const mid = y + h / 2;
    expect(rangeBetween(runs, [x - 0.02, mid], [x + w + 0.1, mid])).toEqual([{ run: "t0" }]);
    expect(rangeBetween(runs, [x + w + 0.1, mid], [x + w + 0.1, mid])).toBeNull();
    // A drag below the line selects nothing.
    expect(rangeBetween(runs, [x, mid + h * 2], [x + w, mid + h * 2])).toBeNull();
  });
});

describe("slide keys and presenter clickers", () => {
  it("moves with arrows, page keys and space, blanks with B, and swallows F5", () => {
    for (const key of ["ArrowRight", "ArrowDown", "PageDown", " ", "n"]) expect(keyAction({ key })?.kind).toBe("next");
    for (const key of ["ArrowLeft", "ArrowUp", "PageUp", "p"]) expect(keyAction({ key })?.kind).toBe("prev");
    expect(keyAction({ key: "b" })?.kind).toBe("blank");
    expect(keyAction({ key: "F5" })?.kind).toBe("swallow");
    expect(keyAction({ key: "l" })).toEqual({ kind: "tool", tool: "laser" });
    expect(keyAction({ key: "r", ctrlKey: true })).toBeNull();
  });

  it("leaves typing in the notes alone, except a clicker's page keys", () => {
    const notes = document.createElement("textarea");
    expect(keyAction({ key: "ArrowRight", target: notes })).toBeNull();
    expect(keyAction({ key: "b", target: notes })).toBeNull();
    expect(keyAction({ key: "PageDown", target: notes })?.kind).toBe("next");
  });
});

describe("the speaker token", () => {
  const token = (claims: object) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;
  const now = 1_793_000_000_000;

  it("accepts a token for this room's teacher and slides", () => {
    const t = token({
      publish: ["talk/dev/slides", "talk/dev/teacher"],
      subscribe: ["talk/dev/**"],
      exp: 1_793_200_000,
    });
    expect(checkToken(t, "dev", now)).toEqual({ kind: "ok", expires: 1_793_200_000_000 });
  });

  it("says when it is missing, expired or for another room", () => {
    expect(checkToken(undefined, "dev", now).kind).toBe("none");
    expect(checkToken("garbage", "dev", now).kind).toBe("unreadable");
    expect(
      checkToken(token({ publish: ["talk/dev/teacher", "talk/dev/slides"], exp: 1_700_000_000 }), "dev", now).kind,
    ).toBe("expired");
    expect(checkToken(token({ publish: ["talk/other/teacher", "talk/other/slides"] }), "dev", now)).toEqual({
      kind: "wrong-room",
      missing: ["talk/dev/teacher", "talk/dev/slides"],
    });
  });

  it("matches moq path patterns", () => {
    expect(patternCovers("talk/*/teacher", "talk/dev/teacher")).toBe(true);
    expect(patternCovers("talk/dev/**", "talk/dev/slides")).toBe(true);
    expect(patternCovers("talk/dev/agents/**", "talk/dev/slides")).toBe(false);
  });
});

describe("the eraser", () => {
  it("finds the strokes it touches, and only those", () => {
    const by = { id: "speaker", name: "Ada", speaker: true };
    const stroke = (id: string, points: [number, number][]) => ({
      m: 0,
      data: {
        kind: "stroke" as const,
        stroke: id,
        deck: 0,
        index: 0,
        tool: "pen" as const,
        color: "#000000",
        width: 0.004,
        points,
        by,
        done: true,
      },
    });
    const strokes = [
      stroke("a", [
        [0.1, 0.1],
        [0.5, 0.1],
      ]),
      stroke("b", [[0.1, 0.8]]),
    ];
    expect(strokesAt(strokes, [0.3, 0.105], 16 / 9)).toEqual(["a"]);
    expect(strokesAt(strokes, [0.1, 0.805], 16 / 9)).toEqual(["b"]);
    expect(strokesAt(strokes, [0.9, 0.5], 16 / 9)).toEqual([]);
  });
});

describe("drawing keys", () => {
  it("picks shapes by letter and every tool by digit, in toolbar order", () => {
    expect(keyAction({ key: "r" })).toEqual({ kind: "tool", tool: "rect" });
    expect(keyAction({ key: "o" })).toEqual({ kind: "tool", tool: "ellipse" });
    expect(keyAction({ key: "a" })).toEqual({ kind: "tool", tool: "arrow" });
    expect(keyAction({ key: "i" })).toEqual({ kind: "tool", tool: "line" });
    expect(keyAction({ key: "1" })).toEqual({ kind: "tool", tool: "laser" });
    expect(keyAction({ key: "4" })).toEqual({ kind: "tool", tool: "rect" });
    expect(keyAction({ key: "0" })).toEqual({ kind: "tool", tool: "eraser" });
  });

  it("undoes with Ctrl+Z (or Cmd+Z), redoes with Ctrl+Y or Ctrl+Shift+Z, and leaves the notes their own undo", () => {
    expect(keyAction({ key: "z", ctrlKey: true })).toEqual({ kind: "undo" });
    expect(keyAction({ key: "z", metaKey: true })).toEqual({ kind: "undo" });
    expect(keyAction({ key: "y", ctrlKey: true })).toEqual({ kind: "redo" });
    expect(keyAction({ key: "Z", ctrlKey: true, shiftKey: true })).toEqual({ kind: "redo" });
    const notes = document.createElement("textarea");
    expect(keyAction({ key: "z", ctrlKey: true, target: notes })).toBeNull();
    expect(keyAction({ key: "[" })).toEqual({ kind: "width", step: -1 });
    expect(keyAction({ key: "]" })).toEqual({ kind: "width", step: 1 });
  });
});

describe("the eraser on shapes", () => {
  const by = { id: "speaker", name: "Ada", speaker: true };
  const shape = (id: string, kind: ShapeKind, start: Point, end: Point) => ({
    m: 0,
    data: {
      kind: "shape" as const,
      stroke: id,
      deck: 0,
      index: 0,
      shape: kind,
      start,
      end,
      color: "#000000",
      width: 0.004,
      by,
    },
  });

  it("takes a rectangle or ellipse by its outline, a line or arrow along it, never from inside", () => {
    const shapes = [
      shape("r", "rect", [0.1, 0.1], [0.3, 0.3]),
      shape("e", "ellipse", [0.5, 0.1], [0.9, 0.5]),
      shape("l", "arrow", [0.1, 0.8], [0.5, 0.8]),
    ];
    expect(strokesAt(shapes, [0.3, 0.2], 16 / 9)).toEqual(["r"]);
    expect(strokesAt(shapes, [0.2, 0.2], 16 / 9)).toEqual([]);
    expect(strokesAt(shapes, [0.9, 0.3], 16 / 9)).toEqual(["e"]);
    expect(strokesAt(shapes, [0.7, 0.3], 16 / 9)).toEqual([]);
    expect(strokesAt(shapes, [0.3, 0.805], 16 / 9)).toEqual(["l"]);
  });
});

describe("Shift while dragging a shape", () => {
  it("makes a square or circle on screen, and lines in 45° steps", () => {
    const aspect = 16 / 9;
    const [x, y] = shapeEnd("rect", [0.1, 0.1], [0.4, 0.2], aspect, true);
    expect((x - 0.1) * aspect).toBeCloseTo(y - 0.1);
    expect(shapeEnd("ellipse", [0.1, 0.1], [0.4, 0.2], aspect, false)).toEqual([0.4, 0.2]);
    const [lx, ly] = shapeEnd("line", [0.5, 0.5], [0.8, 0.52], aspect, true);
    expect(ly).toBeCloseTo(0.5);
    expect(lx).toBeGreaterThan(0.79);
  });
});

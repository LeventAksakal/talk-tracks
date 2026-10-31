// Slide keys and presenter clickers (ui-design §7). Clickers send PageDown/PageUp (some arrows), "b"
// or "." for a black screen, and F5 or Shift+F5 to start a slideshow, which would reload the console
// and end the broadcast, so F5 is swallowed. Drawing keys follow Excalidraw's where ours are free (R, O, A,
// E, digits in toolbar order, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z); L, D and H stay laser, pen, highlighter.

export type ShapeTool = "rect" | "ellipse" | "arrow" | "line";
export type Tool = "none" | "laser" | "pen" | "highlighter" | ShapeTool | "underline" | "highlight" | "eraser";

export const SHAPE_TOOLS: readonly ShapeTool[] = ["rect", "ellipse", "arrow", "line"];
export const isShapeTool = (t: Tool): t is ShapeTool => (SHAPE_TOOLS as readonly Tool[]).includes(t);

/** The toolbar's order; the digit keys 1..9, 0 pick them in this order (as in Excalidraw). */
export const TOOL_ORDER: readonly Exclude<Tool, "none">[] = [
  "laser",
  "pen",
  "highlighter",
  "rect",
  "ellipse",
  "arrow",
  "line",
  "underline",
  "highlight",
  "eraser",
];

export type KeyAction =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "blank" }
  | { kind: "tool"; tool: Tool }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "width"; step: -1 | 1 }
  | { kind: "swallow" };

export const TOOL_KEYS: Record<string, Tool> = {
  l: "laser",
  d: "pen",
  h: "highlighter",
  r: "rect",
  o: "ellipse",
  a: "arrow",
  i: "line",
  u: "underline",
  m: "highlight",
  e: "eraser",
};

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
}

/** Where typing goes (the notes): only the clicker keys still move slides there. */
function isTextField(target: EventTarget | null | undefined): boolean {
  if (!target || typeof (target as HTMLElement).closest !== "function") return false;
  const el = target as HTMLElement;
  return el.isContentEditable || !!el.closest("input, textarea, select, [contenteditable='true']");
}

function isButton(target: EventTarget | null | undefined): boolean {
  return (
    !!target && typeof (target as HTMLElement).closest === "function" && !!(target as HTMLElement).closest("button, a")
  );
}

export function keyAction(e: KeyLike): KeyAction | null {
  if (e.key === "F5") return { kind: "swallow" };
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !isTextField(e.target)) {
    const key = e.key.toLowerCase();
    if (key === "z") return { kind: e.shiftKey ? "redo" : "undo" };
    if (key === "y") return { kind: "redo" };
    return null;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "PageDown") return { kind: "next" };
  if (e.key === "PageUp") return { kind: "prev" };
  if (isTextField(e.target)) return null;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "n":
      return { kind: "next" };
    case " ":
    case "Enter":
      return isButton(e.target) ? null : { kind: "next" };
    case "ArrowLeft":
    case "ArrowUp":
    case "Backspace":
    case "p":
      return { kind: "prev" };
    case "Home":
      return { kind: "first" };
    case "End":
      return { kind: "last" };
    case "b":
    case "B":
    case ".":
      return { kind: "blank" };
    case "Escape":
      return { kind: "tool", tool: "none" };
    case "[":
      return { kind: "width", step: -1 };
    case "]":
      return { kind: "width", step: 1 };
  }
  if (/^[0-9]$/.test(e.key)) {
    const tool = TOOL_ORDER[(Number(e.key) + 9) % 10];
    return tool ? { kind: "tool", tool } : null;
  }
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  return tool ? { kind: "tool", tool } : null;
}

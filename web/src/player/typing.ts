/**
 * Whether a key event is typing into a text field: a text input, a textarea, a select or a contenteditable, found
 * along the event's composed path so a field inside a shadow root (Media Chrome's menus) counts too. Keys typed
 * there belong to the field, never to the player's shortcuts.
 */
const NOT_TEXT = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

export function isTypingNode(node: EventTarget | null | undefined): boolean {
  if (!node || typeof (node as Element).tagName !== "string") return false;
  const el = node as HTMLElement;
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  return tag === "input" && !NOT_TEXT.has(((el as HTMLInputElement).type || "text").toLowerCase());
}

export function isTyping(e: Event): boolean {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  return (path.length ? path : [e.target]).some(isTypingNode);
}

/**
 * The `hotkeys` value Media Chrome's controller gets while a field takes the keys: every key it answers to is
 * switched off, Space and the arrows included, so it neither acts on them nor cancels their default (typing a
 * space, moving the caret).
 */
export const TYPING_HOTKEYS = [
  "noshift+/",
  "nospace",
  ..."kmfcjlp<>".split("").map((k) => `no${k}`),
  "noarrowleft",
  "noarrowright",
  "noarrowup",
  "noarrowdown",
  "noenter",
].join(" ");

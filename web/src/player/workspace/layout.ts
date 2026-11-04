// The player's workspace (owner QA, 2026-11-04): the speaker's streams are tiles on a stage arranged by a view
// (Adjust view, after Google Meet: Auto, Tiled, Spotlight, Sidebar), and the reading panels open one at a time in a
// card on the right. Underneath, every panel can still be docked in one of four zones (left, centre, right, bottom),
// tabbed, split, resized or floated as a small window: the power user's workbench. This file is the model: pure
// functions over a plain object, so every move is testable and the whole layout is one JSON value kept per browser.

export type PanelId =
  "slides" | "screen" | "camera" | "chat" | "transcript" | "chapters" | "discussion" | (string & {});
export type Zone = "left" | "centre" | "right" | "bottom";
export const ZONES: readonly Zone[] = ["left", "centre", "right", "bottom"];

/** The panels the player knows, in menu order. Pictures show a source; the rest are things to read or write. */
export const PANELS: readonly { id: PanelId; label: string; picture: boolean }[] = [
  { id: "slides", label: "Slides", picture: true },
  { id: "screen", label: "Screen share", picture: true },
  { id: "camera", label: "Speaker", picture: true },
  { id: "chat", label: "Chat", picture: false },
  { id: "transcript", label: "Transcript", picture: false },
  { id: "chapters", label: "Chapters", picture: false },
  { id: "discussion", label: "Discussion", picture: false },
];

export const isPicture = (id: PanelId) => id === "slides" || id === "screen" || id === "camera";

/** The speaker's streams, in the order a view lays them out. */
export const PICTURES: readonly PanelId[] = ["slides", "screen", "camera"];

export interface ZoneState {
  /** The panels docked here, in tab (or split) order. */
  panels: PanelId[];
  /** The tab in front, when shown as tabs. */
  active: PanelId | undefined;
  /** Side by side (a grid) instead of tabs. */
  split: boolean;
  /** Split with two panels: the first one's share of the zone. */
  share: number;
  /** Split as a sidebar: the first panel large, the others in a column of small tiles beside it. */
  strip?: boolean;
}

/** A floating window, as fractions of the workspace (a picture's height follows its width). */
export interface FloatBox {
  id: PanelId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  zones: Record<Zone, ZoneState>;
  /** Floating windows, the last one on top. */
  floating: FloatBox[];
  /** The side zones' widths and the bottom zone's height, px. */
  size: { left: number; right: number; bottom: number };
  /** Where a closed panel goes back to when reopened. */
  home: Partial<Record<PanelId, Zone>>;
  /** The view picked in Adjust view; undefined once the viewer arranges the streams by hand. */
  view?: PresetId;
}

/**
 * The views of Adjust view (Google Meet's, for a lecture): they arrange the speaker's streams on the stage and leave
 * the reading panels alone. Auto follows the talk (a shared screen, else the slides, large, the speaker beside them;
 * the speaker alone when there is nothing else); Tiled puts every stream side by side; Spotlight shows one; Sidebar
 * one large and the others in a column beside it.
 */
export type PresetId = "auto" | "tiled" | "spotlight" | "sidebar";

export const PRESETS: readonly { id: PresetId; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Follows the talk: what the speaker shows, large" },
  { id: "tiled", label: "Tiled", hint: "Every stream side by side" },
  { id: "spotlight", label: "Spotlight", hint: "One stream fills the stage" },
  { id: "sidebar", label: "Sidebar", hint: "One stream large, the others beside it" },
];

export const SIZE_LIMITS = { min: 220, max: 640 } as const;
export const DEFAULT_SIZE = { left: 300, right: 360, bottom: 220 } as const;
export const SHARE_LIMITS = { min: 0.2, max: 0.8 } as const;
export const FLOAT_WIDTH = { min: 0.12, max: 0.6 } as const;

const zone = (panels: PanelId[], split = false, share = 0.5, active = panels[0]): ZoneState => ({
  panels,
  active,
  split,
  share,
});

/** The stage (the centre zone) as a view arranges it. */
function stageFor(id: PresetId, panels: PanelId[] = [...PICTURES]): ZoneState {
  if (id === "tiled") return zone(panels, true);
  if (id === "spotlight") return zone(panels, false);
  return { ...zone(panels, true), strip: true };
}

/** A view, fresh: the stage arranged, no reading panel open. */
export function preset(id: PresetId): Layout {
  return withHomes({
    zones: { left: zone([]), centre: stageFor(id), right: zone([]), bottom: zone([]) },
    floating: [],
    size: { ...DEFAULT_SIZE },
    home: {},
    view: id,
  });
}

export const DEFAULT_PRESET: PresetId = "auto";

/**
 * Switch to a view: the streams leave wherever they were (a side, a window) and take the stage as the view arranges
 * them, the one in front first; the reading panels stay where they are.
 */
export function applyView(l: Layout, id: PresetId): Layout {
  const was = l.zones.centre.active;
  const front = was !== undefined && isPicture(was) && id !== "auto" ? was : undefined;
  let out = l;
  for (const p of PICTURES) out = detach(out, p);
  const pictures = front ? [front, ...PICTURES.filter((p) => p !== front)] : [...PICTURES];
  const stage = stageFor(id, [...pictures, ...out.zones.centre.panels]);
  const home = { ...out.home };
  for (const p of PICTURES) home[p] = "centre";
  return { ...out, zones: { ...out.zones, centre: stage }, home, view: id };
}

/** Make a stream the large one: first in its zone and in front. Auto then stops choosing (it becomes Sidebar). */
export function promote(l: Layout, id: PanelId): Layout {
  const at = where(l, id);
  if (!at || at === "floating") return l;
  const s = l.zones[at];
  return {
    ...l,
    zones: { ...l.zones, [at]: { ...s, panels: [id, ...s.panels.filter((p) => p !== id)], active: id } },
    view: l.view === "auto" ? "sidebar" : l.view,
  };
}

/** The camera's small window: bottom right, clear of a right-hand zone of the default width on a laptop screen. */
function cameraWindow(): FloatBox {
  return { id: "camera", x: 0.56, y: 0.6, w: 0.18, h: 0.26 };
}

function withHomes(l: Layout): Layout {
  const home = { ...l.home };
  for (const z of ZONES) for (const id of l.zones[z].panels) home[id] ??= z;
  return { ...l, home };
}

/** A move of a stream by hand ends the picked view; a reading panel's move keeps it. */
const byHand = (l: Layout, id: PanelId): Layout => (isPicture(id) ? { ...l, view: undefined } : l);

/** Where a panel is: a zone, floating, or closed (undefined). */
export function where(l: Layout, id: PanelId): Zone | "floating" | undefined {
  for (const z of ZONES) if (l.zones[z].panels.includes(id)) return z;
  return l.floating.some((f) => f.id === id) ? "floating" : undefined;
}

/** Take a panel out of wherever it is (its zone keeps a sensible tab in front). */
function detach(l: Layout, id: PanelId): Layout {
  const zones = { ...l.zones };
  for (const z of ZONES) {
    const s = zones[z];
    const i = s.panels.indexOf(id);
    if (i < 0) continue;
    const panels = s.panels.filter((p) => p !== id);
    zones[z] = {
      ...s,
      panels,
      active: s.active === id ? (panels[Math.min(i, panels.length - 1)] ?? undefined) : s.active,
    };
  }
  return { ...l, zones, floating: l.floating.filter((f) => f.id !== id) };
}

/** Dock a panel in a zone (at `index`, else last), in front. */
export function dock(l: Layout, id: PanelId, z: Zone, index?: number): Layout {
  const out = detach(l, id);
  const s = out.zones[z];
  const panels = [...s.panels];
  panels.splice(index === undefined ? panels.length : Math.max(0, Math.min(index, panels.length)), 0, id);
  return byHand(
    {
      ...out,
      zones: { ...out.zones, [z]: { ...s, panels, active: id } },
      home: { ...out.home, [id]: z },
    },
    id,
  );
}

/** Float a panel as a small window (at `box`, else a default spot), on top. */
export function float(l: Layout, id: PanelId, box?: Omit<FloatBox, "id">): Layout {
  const from = where(l, id);
  const out = detach(l, id);
  const home = from && from !== "floating" ? { ...out.home, [id]: from } : out.home;
  const b = box ?? (isPicture(id) ? cameraWindow() : { x: 0.3, y: 0.18, w: 0.26, h: 0.5 });
  return byHand({ ...out, floating: [...out.floating, clampBox({ ...b, id })], home }, id);
}

/** Move or resize a floating window, and bring it to the top. */
export function moveFloat(l: Layout, box: FloatBox): Layout {
  if (!l.floating.some((f) => f.id === box.id)) return l;
  return { ...l, floating: [...l.floating.filter((f) => f.id !== box.id), clampBox(box)] };
}

function clampBox(b: FloatBox): FloatBox {
  const w = clamp(b.w, FLOAT_WIDTH.min, FLOAT_WIDTH.max);
  const h = clamp(b.h, 0.1, 0.9);
  return { id: b.id, w, h, x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - Math.min(h, 0.2)) };
}

/** Close a panel; it remembers its zone for when it is reopened. */
export function close(l: Layout, id: PanelId): Layout {
  const from = where(l, id);
  const out = detach(l, id);
  return byHand(from && from !== "floating" ? { ...out, home: { ...out.home, [id]: from } } : out, id);
}

/** Open a panel where it was last docked (a picture in the centre, anything else on the right), in front. */
export function open(l: Layout, id: PanelId): Layout {
  const at = where(l, id);
  if (at === "floating")
    return moveFloat(
      l,
      l.floating.find((f) => f.id === id)!,
    );
  if (at) return activate(l, at, id);
  return dock(l, id, l.home[id] ?? (isPicture(id) ? "centre" : "right"));
}

export function toggle(l: Layout, id: PanelId): Layout {
  return where(l, id) ? close(l, id) : open(l, id);
}

/**
 * Show a reading panel in the right-hand card (Meet's side panel): it replaces the reading panel shown there. One the
 * viewer docked elsewhere or floated is brought to the front where it is.
 */
export function showPanel(l: Layout, id: PanelId): Layout {
  const at = where(l, id);
  if (at && at !== "right") return open(l, id);
  let out = l;
  for (const p of l.zones.right.panels) if (p !== id && !isPicture(p)) out = close(out, p);
  return at === "right" ? activate(out, "right", id) : dock(out, id, "right");
}

/** The side panel buttons: show a reading panel in the card, or close it when it is already on screen. */
export function togglePanel(l: Layout, id: PanelId, onScreen: ReadonlySet<PanelId>): Layout {
  return onScreen.has(id) ? close(l, id) : showPanel(l, id);
}

/** Bring a docked panel's tab to the front. */
export function activate(l: Layout, z: Zone, id: PanelId): Layout {
  const s = l.zones[z];
  if (!s.panels.includes(id) || s.active === id) return l;
  return { ...l, zones: { ...l.zones, [z]: { ...s, active: id } } };
}

/** Show a zone's panels side by side, or as tabs. */
export function setSplit(l: Layout, z: Zone, split: boolean): Layout {
  const out = { ...l, zones: { ...l.zones, [z]: { ...l.zones[z], split, strip: false } } };
  return l.zones[z].panels.some(isPicture) ? { ...out, view: undefined } : out;
}

export function setShare(l: Layout, z: Zone, share: number): Layout {
  const s = clamp(share, SHARE_LIMITS.min, SHARE_LIMITS.max);
  return { ...l, zones: { ...l.zones, [z]: { ...l.zones[z], share: s } } };
}

export function resizeZone(l: Layout, edge: keyof Layout["size"], px: number): Layout {
  return { ...l, size: { ...l.size, [edge]: clamp(Math.round(px), SIZE_LIMITS.min, SIZE_LIMITS.max) } };
}

/** Auto's pick of the large stream: a shared screen, else the slides, else the speaker. */
const AUTO_ORDER: readonly PanelId[] = ["screen", "slides", "camera"];

/**
 * What the viewer sees, given the panels this room has (`available`): each zone's available panels and the one in
 * front, the floating windows of available panels. In Auto the stage puts what the speaker shows first. With nothing
 * to show in the centre, the first floating picture takes it: the talk never plays in a small window over an empty
 * stage.
 */
export function resolve(l: Layout, available: ReadonlySet<PanelId>): Layout {
  const zones = { ...l.zones };
  for (const z of ZONES) {
    const s = zones[z];
    const panels = s.panels.filter((p) => available.has(p));
    const active = s.active !== undefined && panels.includes(s.active) ? s.active : panels[0];
    zones[z] = { ...s, panels, active };
  }
  if (l.view === "auto") {
    const s = zones.centre;
    const rank = (p: PanelId) => {
      const i = AUTO_ORDER.indexOf(p);
      return i < 0 ? AUTO_ORDER.length : i;
    };
    const panels = [...s.panels].sort((a, b) => rank(a) - rank(b));
    zones.centre = { ...s, panels, active: panels[0] };
  }
  let floating = l.floating.filter((f) => available.has(f.id));
  if (zones.centre.panels.length === 0) {
    const lone = floating.find((f) => isPicture(f.id));
    if (lone) {
      floating = floating.filter((f) => f !== lone);
      zones.centre = { ...zones.centre, panels: [lone.id], active: lone.id };
    }
  }
  return { ...l, zones, floating };
}

/** The panels on screen in a resolved layout: every panel of a split zone, the front tab of the others, the windows. */
export function visible(l: Layout): Set<PanelId> {
  const out = new Set<PanelId>();
  for (const z of ZONES) {
    const s = l.zones[z];
    if (s.split) s.panels.forEach((p) => out.add(p));
    else if (s.active !== undefined) out.add(s.active);
  }
  l.floating.forEach((f) => out.add(f.id));
  return out;
}

// --- kept per browser -------------------------------------------------------------------------------

/** v2: the Meet-style views (v1 held the workbench presets; those layouts are left behind, not converted). */
export const LAYOUT_KEY = "tt.workspace.v2";

const VIEWS = new Set<string>(PRESETS.map((p) => p.id));

/** A saved layout, if it reads as one; anything else (an older shape, a hand edit) gives undefined. */
export function parseLayout(raw: string | null | undefined): Layout | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<Layout>;
    if (!v || typeof v !== "object" || !v.zones || !Array.isArray(v.floating)) return undefined;
    const zones = {} as Record<Zone, ZoneState>;
    const seen = new Set<string>();
    for (const z of ZONES) {
      const s = v.zones[z] as Partial<ZoneState> | undefined;
      const panels = Array.isArray(s?.panels)
        ? s.panels.filter((p): p is string => typeof p === "string" && !seen.has(p) && (seen.add(p), true))
        : [];
      zones[z] = {
        panels,
        active: typeof s?.active === "string" && panels.includes(s.active) ? s.active : panels[0],
        split: s?.split === true,
        share: typeof s?.share === "number" ? clamp(s.share, SHARE_LIMITS.min, SHARE_LIMITS.max) : 0.5,
        ...(s?.strip === true ? { strip: true } : {}),
      };
    }
    const floating = v.floating
      .filter(
        (f): f is FloatBox =>
          !!f && typeof f.id === "string" && !seen.has(f.id) && [f.x, f.y, f.w, f.h].every(Number.isFinite),
      )
      .map(clampBox);
    const size: Layout["size"] = { ...DEFAULT_SIZE };
    for (const k of ["left", "right", "bottom"] as const) {
      const px = v.size?.[k];
      if (typeof px === "number" && Number.isFinite(px)) size[k] = clamp(px, SIZE_LIMITS.min, SIZE_LIMITS.max);
    }
    const home: Layout["home"] = {};
    for (const [id, z] of Object.entries(v.home ?? {})) if (ZONES.includes(z as Zone)) home[id] = z as Zone;
    const view = typeof v.view === "string" && VIEWS.has(v.view) ? (v.view as PresetId) : undefined;
    return { zones, floating, size, home, ...(view ? { view } : {}) };
  } catch {
    return undefined;
  }
}

export function readLayout(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Layout {
  try {
    return parseLayout(storage?.getItem(LAYOUT_KEY)) ?? preset(DEFAULT_PRESET);
  } catch {
    return preset(DEFAULT_PRESET);
  }
}

export function writeLayout(l: Layout, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    // Storage full or blocked: the layout lasts for this page only.
  }
}

export function forgetLayout(storage: Pick<Storage, "removeItem"> | undefined = safeStorage()): void {
  try {
    storage?.removeItem(LAYOUT_KEY);
  } catch {
    // Nothing kept to forget.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

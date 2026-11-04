// Per-device preferences (decision 0020): the stage layout, subtitle language and style, the side panel. There are no feature switches (decision 0026): a track is subscribed while what needs it is picked or
// open (tracks.ts). Kept in localStorage, which can be missing or throw (private windows, blocked storage): every read
// and write is guarded and the player works without it.

import { useCallback, useEffect, useState } from "react";

export type LayoutKind = "single" | "split" | "pip";
/** A picture on the stage. A shared screen takes the slides' place while it is shared (Stage.stageSources). */
export type SourceKind = "camera" | "slides" | "screen";
/** The main picture's two candidates: the slides, or a shared screen. */
export type BoardKind = "slides" | "screen";
export type SubtitlePreset = "default" | "large" | "contrast" | "light";
export type PanelTab = "transcript" | "chapters" | "glossary" | "descriptions" | "notes" | (string & {});

/** A point as fractions of a box, x from the left, y from the top. */
export interface Fraction {
  x: number;
  y: number;
}

export interface SubtitleStyle {
  preset: SubtitlePreset;
  /** Font size, CSS px at 100 % zoom. */
  size: number;
  /** Background opacity, 0–1. */
  background: number;
  /** Lines of the newest cue shown at most. */
  lines: 1 | 2 | 3;
  /** Show the still-forming words (lighter than final ones). */
  interim: boolean;
}

export interface Prefs {
  /** Subtitles on: a language is picked. */
  cc: boolean;
  /** "original", or the BCP 47 tag of a translation. */
  subtitleLang: string;
  /**
   * The room the subtitle language was picked in. Elsewhere a remembered translation applies only when it costs
   * nothing more there (tracks.roomSubtitles); a paid one is offered, never subscribed unasked.
   */
  subtitleRoom?: string;
  style: SubtitleStyle;
  /**
   * The stage (decision 0026): "pip" is the default, the slides filling it and the camera in a corner tile; "split"
   * puts them side by side; "single" shows one. With no deck the camera fills the stage whatever this says.
   */
  layout: LayoutKind;
  /** Split and the corner tile: the camera is the left or small one unless swapped. */
  swap: boolean;
  /** Single layout: the camera, or the main picture ("slides" or "screen" both mean the main picture). */
  single: SourceKind;
  /**
   * While a screen is shared, which of it and the slides is the main picture (Stage.mainPicture). The screen unless
   * the listener picks the slides; with only one of them, that one, whatever this says.
   */
  board: BoardKind;
  /** Split: the first cell's share of the width. */
  split: number;
  /** The corner tile's top-left corner, as fractions of the canvas; undefined: the bottom-right corner. */
  pipPos: Fraction | undefined;
  /** The corner tile's width, as a fraction of the canvas. */
  pipWidth: number;
  panel: boolean;
  tab: PanelTab;
  volume: number;
  muted: boolean;
}

export const SUBTITLE_PRESETS: Record<SubtitlePreset, { label: string; size?: number }> = {
  default: { label: "Default" },
  large: { label: "Large", size: 30 },
  contrast: { label: "High contrast" },
  light: { label: "Light box" },
};

export const DEFAULT_STYLE: SubtitleStyle = { preset: "default", size: 26, background: 0.85, lines: 2, interim: true };

export const PIP_WIDTH = { min: 0.14, default: 0.24, max: 0.5 } as const;

export const DEFAULT_PREFS: Prefs = {
  cc: false,
  subtitleLang: "original",
  style: DEFAULT_STYLE,
  layout: "pip",
  swap: false,
  single: "slides",
  board: "screen",
  split: 0.34,
  pipPos: undefined,
  pipWidth: PIP_WIDTH.default,
  panel: true,
  tab: "transcript",
  volume: 1,
  muted: false,
};

/** v2 (2026-10-31): the stage defaults to the corner tile and the feature switches are gone, so v1 is not read. */
export const PREFS_KEY = "tt.player.v2";

export function readPrefs(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Prefs {
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const saved = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...saved, style: { ...DEFAULT_STYLE, ...saved.style } };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writePrefs(prefs: Prefs, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the preference lasts for this page only.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The device's preferences, saved on every change. */
export function usePrefs(): [Prefs, (change: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)) => void] {
  const [prefs, setPrefs] = useState(readPrefs);
  useEffect(() => writePrefs(prefs), [prefs]);
  const update = useCallback(
    (change: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)) =>
      setPrefs((p) => ({ ...p, ...(typeof change === "function" ? change(p) : change) })),
    [],
  );
  return [prefs, update];
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

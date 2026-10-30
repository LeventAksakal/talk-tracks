// Per-device preferences (decision 0020): layout, subtitle language, style and position, the features the
// viewer turned on. Kept in localStorage, which can be missing or throw (private windows, blocked storage):
// every read and write is guarded and the player works without it.

import { useCallback, useEffect, useState } from "react";

export type LayoutKind = "single" | "split" | "pip";
export type SourceKind = "camera" | "slides";
export type SubtitlePreset = "default" | "large" | "contrast" | "light";
export type PanelTab = "transcript" | "chapters" | "glossary" | "notes" | (string & {});

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
  /** Subtitles on. */
  cc: boolean;
  /** "original", or the BCP 47 tag of a translation. */
  subtitleLang: string;
  /** The original, small, above the translation. */
  dual: boolean;
  style: SubtitleStyle;
  /** Where the subtitles' bottom centre sits, as fractions of the canvas; undefined: the default spot. */
  subtitlePos: Fraction | undefined;
  layout: LayoutKind;
  /** Split and picture-in-picture: the camera is the small or left one unless swapped. */
  swap: boolean;
  /** Single layout: which source fills the canvas. */
  single: SourceKind;
  /** Split: the first cell's share of the width. */
  split: number;
  /** Picture-in-picture: the small window's top-left corner, as fractions of the canvas. */
  pipPos: Fraction | undefined;
  panel: boolean;
  tab: PanelTab;
  /** Chapters, glossary and recap (the outline agent). */
  chapters: boolean;
  /** The transcript tab keeps the captions track on even with subtitles off. */
  transcript: boolean;
  /** Slide descriptions: off, as text, or read aloud as well. */
  describe: "off" | "text" | "speak";
  /** Ink and text marks on the slides: everyone's, or the speaker's only (decision 0021). */
  annotations: "everyone" | "speaker";
  volume: number;
  muted: boolean;
}

export const SUBTITLE_PRESETS: Record<SubtitlePreset, { label: string; size?: number }> = {
  default: { label: "Default" },
  large: { label: "Large", size: 30 },
  contrast: { label: "High contrast" },
  light: { label: "Light box" },
};

export const DEFAULT_STYLE: SubtitleStyle = { preset: "default", size: 20, background: 0.6, lines: 2, interim: true };

export const DEFAULT_PREFS: Prefs = {
  cc: false,
  subtitleLang: "original",
  dual: false,
  style: DEFAULT_STYLE,
  subtitlePos: undefined,
  layout: "split",
  swap: false,
  single: "slides",
  split: 0.34,
  pipPos: undefined,
  panel: true,
  tab: "transcript",
  chapters: false,
  transcript: false,
  describe: "off",
  annotations: "everyone",
  volume: 1,
  muted: false,
};

export const PREFS_KEY = "tt.player.v1";

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

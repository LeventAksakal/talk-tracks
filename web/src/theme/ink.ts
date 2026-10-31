// The chalk box (wiki/product/brand.md §3): the speaker's and listeners' ink colours. The values live in tokens.css as
// --tt-ink-*; a stroke goes out on its track as a colour string, so the code reads the token's value when it needs
// one. The hex here is only the fallback for a page without the stylesheet (tests, a worker).

export type InkName = "chalk" | "sun" | "mint" | "apricot" | "sky" | "rose" | "coral" | "lilac";

export interface Ink {
  name: InkName;
  /** As a person says it, for labels: "Sky". */
  label: string;
  token: `--tt-ink-${InkName}`;
  fallback: string;
}

const ink = (name: InkName, fallback: string): Ink => ({
  name,
  label: name[0]!.toUpperCase() + name.slice(1),
  token: `--tt-ink-${name}`,
  fallback,
});

/** In key order: 1 is Chalk, 8 is Lilac. */
export const CHALK_BOX: readonly Ink[] = [
  ink("chalk", "#f7f4ea"),
  ink("sun", "#ffd84a"),
  ink("mint", "#5fd68a"),
  ink("apricot", "#ff9a3c"),
  ink("sky", "#5fb3ff"),
  ink("rose", "#ff6fae"),
  ink("coral", "#ff5f57"),
  ink("lilac", "#b79cff"),
];

const byName = new Map(CHALK_BOX.map((i) => [i.name, i]));

/** A token's value on this page, or `fallback` where no stylesheet sets it. */
export function tokenValue(token: string, fallback: string): string {
  try {
    if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
  } catch {
    return fallback;
  }
}

/** The colour of a chalk, as a string to draw with or to put on a track. */
export function inkColor(name: InkName): string {
  const i = byName.get(name)!;
  return tokenValue(i.token, i.fallback);
}

/** The chalk whose colour this is (a stroke read back from a track), if any. */
export function inkNamed(color: string): Ink | undefined {
  const c = color.trim().toLowerCase();
  return CHALK_BOX.find((i) => inkColor(i.name).toLowerCase() === c || i.fallback === c);
}

/** The laser's colour (--tt-laser). */
export const laserColor = () => tokenValue("--tt-laser", "#ff3b30");

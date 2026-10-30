// Subtitle languages for the CC menu's "Translate to…" search (ui-design §4.2, decision 0019): every
// language named in its own script (Intl.DisplayNames with the language as locale) and in the viewer's.

import { dirOf } from "../viewer/lang";

/**
 * Languages offered for translation. A placeholder until the Any-language translation lane hands over the
 * model's list (lane briefs); BCP 47 tags.
 */
// prettier-ignore
export const SUPPORTED_LANGUAGES = [
  "ar", "bn", "bg", "ca", "cs", "da", "de", "el", "en", "es", "et", "fa", "fi", "fil", "fr", "gu", "he", "hi", "hr",
  "hu", "id", "it", "ja", "kn", "ko", "lt", "lv", "ml", "mr", "ms", "nl", "no", "pa", "pl", "pt", "ro", "ru", "sk",
  "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk", "ur", "vi", "zh",
] as const;

export interface LanguageOption {
  tag: string;
  /** The language in itself: "Türkçe". */
  autonym: string;
  /** The language in the viewer's language: "Turkish". */
  local: string;
  dir: "ltr" | "rtl";
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

function namesIn(locale: string): Intl.DisplayNames | null {
  if (!displayNames.has(locale)) {
    try {
      displayNames.set(locale, new Intl.DisplayNames([locale], { type: "language", fallback: "none" }));
    } catch {
      displayNames.set(locale, null);
    }
  }
  return displayNames.get(locale) ?? null;
}

function nameOf(tag: string, locale: string): string | undefined {
  try {
    return namesIn(locale)?.of(tag) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A language with its names; the tag stands in for a name the browser does not know. */
export function languageOption(tag: string, viewerLocale = defaultLocale()): LanguageOption {
  const local = nameOf(tag, viewerLocale) ?? nameOf(tag, "en") ?? tag;
  const autonym = nameOf(tag, tag) ?? local;
  return { tag, autonym: capitalise(autonym, tag), local: capitalise(local, viewerLocale), dir: dirOf(tag) };
}

/** "Türkçe · Turkish", or one name when both are the same. */
export function languageLabel(option: LanguageOption): string {
  return option.autonym === option.local ? option.autonym : `${option.autonym} · ${option.local}`;
}

/** Fold case and accents so "turk" finds "Türkçe" and "espanol" finds "Español". */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase();
}

/**
 * The languages matching `query` by autonym, the viewer's name, the English name or the tag; names that
 * start with the query come first. An empty query keeps the order given.
 */
export function searchLanguages(options: readonly LanguageOption[], query: string): LanguageOption[] {
  const q = fold(query.trim());
  if (!q) return [...options];
  const scored: { option: LanguageOption; score: number }[] = [];
  for (const option of options) {
    const english = nameOf(option.tag, "en") ?? "";
    const names = [option.autonym, option.local, english].map(fold);
    const tag = option.tag.toLowerCase();
    const score = names.some((n) => n.startsWith(q))
      ? 0
      : tag === q
        ? 0
        : names.some((n) => n.split(/[\s(),-]+/).some((w) => w.startsWith(q)))
          ? 1
          : names.some((n) => n.includes(q))
            ? 2
            : -1;
    if (score >= 0) scored.push({ option, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.option);
}

function defaultLocale(): string {
  return typeof navigator !== "undefined" && navigator.language ? navigator.language : "en";
}

function capitalise(name: string, locale: string): string {
  try {
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return name;
  }
}

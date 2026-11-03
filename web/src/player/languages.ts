// Subtitle languages for the CC menu's "Translate to…" search (ui-design §4.2, decision 0019): every
// language named in its own script (Intl.DisplayNames with the language as locale) and in the viewer's.

import languageList from "../../../contracts/languages.json";
import { dirOf } from "../viewer/lang";

/**
 * Languages offered for translation, BCP 47 tags: the one list in contracts/languages.json (decision 0035), which
 * the agents' translate-any serves too. Every one is made lazily, on first pick.
 */
export const SUPPORTED_LANGUAGES: readonly string[] = languageList.languages.map((l) => l.tag);

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

const options = new Map<string, LanguageOption>();

/** A language with its names; the tag stands in for a name the browser does not know. Cached by tag and locale. */
export function languageOption(tag: string, viewerLocale = defaultLocale()): LanguageOption {
  const key = `${tag}|${viewerLocale}`;
  let option = options.get(key);
  if (!option) {
    const local = nameOf(tag, viewerLocale) ?? nameOf(tag, "en") ?? tag;
    const autonym = nameOf(tag, tag) ?? local;
    option = { tag, autonym: capitalise(autonym, tag), local: capitalise(local, viewerLocale), dir: dirOf(tag) };
    options.set(key, option);
  }
  return option;
}

const lists = new Map<string, readonly LanguageOption[]>();

/** Every supported language with its names, built on the first call (the CC menu's first open), then cached. */
export function supportedLanguageOptions(viewerLocale = defaultLocale()): readonly LanguageOption[] {
  let list = lists.get(viewerLocale);
  if (!list) {
    list = SUPPORTED_LANGUAGES.map((tag) => languageOption(tag, viewerLocale));
    lists.set(viewerLocale, list);
  }
  return list;
}

/** Fold case and accents so "turk" finds "Türkçe" and "espanol" finds "Español". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
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

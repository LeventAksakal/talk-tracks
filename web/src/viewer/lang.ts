const RTL = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv"]);

/** Text direction of a BCP 47 language tag. */
export function dirOf(lang: string | undefined): "rtl" | "ltr" {
  const base = (lang ?? "").toLowerCase().split("-")[0] ?? "";
  return RTL.has(base) ? "rtl" : "ltr";
}

/** The language's name in the viewer's own language ("Turkish"), or the tag itself. */
export function languageName(lang: string | undefined, locale = navigator.language): string {
  if (!lang) return "";
  try {
    return new Intl.DisplayNames([locale, "en"], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

/** The language's name in itself ("Türkçe"), for labels a speaker of it will look for. */
export function nativeLanguageName(lang: string | undefined): string {
  if (!lang) return "";
  try {
    return new Intl.DisplayNames([lang], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

/** mm:ss (or h:mm:ss) for a media time in ms. */
export function formatMediaTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

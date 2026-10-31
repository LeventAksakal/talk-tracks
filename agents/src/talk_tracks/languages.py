"""BCP 47 language tags and Muse LLM language support (Decision 0019).

Muse Spark supports translation into major world languages. Subtitle languages use BCP 47 tags
(RFC 5646), and names display in English or the viewer's locale via Intl.DisplayNames.
"""

from __future__ import annotations

import re

# The 50 languages supported by the Muse model for subtitle translation (decision 0019, ui-design §4.2).
SUPPORTED_LANGUAGES: tuple[str, ...] = (
    "ar",
    "bn",
    "bg",
    "ca",
    "cs",
    "da",
    "de",
    "el",
    "en",
    "es",
    "et",
    "fa",
    "fi",
    "fil",
    "fr",
    "gu",
    "he",
    "hi",
    "hr",
    "hu",
    "id",
    "it",
    "ja",
    "kn",
    "ko",
    "lt",
    "lv",
    "ml",
    "mr",
    "ms",
    "nl",
    "no",
    "pa",
    "pl",
    "pt",
    "ro",
    "ru",
    "sk",
    "sl",
    "sr",
    "sv",
    "sw",
    "ta",
    "te",
    "th",
    "tr",
    "uk",
    "ur",
    "vi",
    "zh",
)

MUSE_LANGUAGES: frozenset[str] = frozenset(SUPPORTED_LANGUAGES)

LANGUAGE_NAMES: dict[str, str] = {
    "ar": "Arabic",
    "bn": "Bengali",
    "bg": "Bulgarian",
    "ca": "Catalan",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "et": "Estonian",
    "fa": "Persian",
    "fi": "Finnish",
    "fil": "Filipino",
    "fr": "French",
    "gu": "Gujarati",
    "he": "Hebrew",
    "hi": "Hindi",
    "hr": "Croatian",
    "hu": "Hungarian",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "kn": "Kannada",
    "ko": "Korean",
    "lt": "Lithuanian",
    "lv": "Latvian",
    "ml": "Malayalam",
    "mr": "Marathi",
    "ms": "Malay",
    "nl": "Dutch",
    "no": "Norwegian",
    "pa": "Punjabi",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sk": "Slovak",
    "sl": "Slovenian",
    "sr": "Serbian",
    "sv": "Swedish",
    "sw": "Swahili",
    "ta": "Tamil",
    "te": "Telugu",
    "th": "Thai",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "ur": "Urdu",
    "vi": "Vietnamese",
    "zh": "Chinese",
}

# Standard BCP 47 syntax: 2-3 letter primary language subtag with optional script, region or variant subtags.
BCP_47_RE = re.compile(r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)*$")


def is_supported_language(tag: str) -> bool:
    """Whether the Muse LLM supports translating into this BCP 47 language tag."""
    cleaned = tag.strip()
    if not cleaned or not BCP_47_RE.match(cleaned):
        return False
    lower = cleaned.lower()
    if lower in MUSE_LANGUAGES:
        return True
    primary = lower.split("-")[0]
    return primary in MUSE_LANGUAGES


def language_name(code: str) -> str:
    """English name of a language code or BCP 47 tag; falls back to primary subtag name or code itself."""
    cleaned = code.strip()
    if not cleaned:
        return ""
    if cleaned in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[cleaned]
    lower = cleaned.lower()
    if lower in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[lower]
    primary = lower.split("-")[0]
    if primary in LANGUAGE_NAMES:
        # e.g. pt-BR -> Portuguese, zh-CN -> Chinese
        return LANGUAGE_NAMES[primary]
    return cleaned


def parse_translation_agent(agent_name: str) -> str | None:
    """Extract the BCP 47 language tag from an agent name like 'translate-tr' or 'translate-de'."""
    if agent_name.startswith("translate-"):
        tag = agent_name[len("translate-") :].strip()
        if tag:
            return tag
    return None


def translation_agent_name(lang: str) -> str:
    """Stable agent name for a translation track: translate-<lang>."""
    return f"translate-{lang.strip().lower()}"

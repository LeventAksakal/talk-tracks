"""BCP 47 language tags and Muse LLM language support (decisions 0019 and 0035).

The subtitle languages are one list, ``contracts/languages.json``, which the web player imports too. The agents image
has no ``contracts/`` folder, so the list reaches the agents as ``language_list.py``, generated from that file:
``python -m talk_tracks.languages`` writes it again, and ``test_languages`` fails while the two differ.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from .language_list import LANGUAGE_NAMES, SUPPORTED_LANGUAGES

LANGUAGES_JSON = Path(__file__).resolve().parents[3] / "contracts" / "languages.json"
GENERATED = Path(__file__).with_name("language_list.py")

MUSE_LANGUAGES: frozenset[str] = frozenset(SUPPORTED_LANGUAGES)

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


# --- the generated list -----------------------------------------------------------------------------------------


def read_languages_json(path: Path = LANGUAGES_JSON) -> list[tuple[str, str]]:
    """``(tag, English name)`` of every language in ``contracts/languages.json``, in its order."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    return [(str(entry["tag"]), str(entry["name"])) for entry in doc["languages"]]


def render_language_list(languages: list[tuple[str, str]]) -> str:
    """The source of ``language_list.py`` for ``languages``."""
    lines = [
        '"""Generated from contracts/languages.json by ``python -m talk_tracks.languages``: do not edit."""',
        "",
        "SUPPORTED_LANGUAGES: tuple[str, ...] = (",
        *(f'    "{tag}",' for tag, _ in languages),
        ")",
        "",
        "LANGUAGE_NAMES: dict[str, str] = {",
        *(f'    "{tag}": "{name}",' for tag, name in languages),
        "}",
    ]
    return "\n".join(lines) + "\n"


def main() -> None:
    GENERATED.write_text(render_language_list(read_languages_json()), encoding="utf-8", newline="\n")
    print("wrote", GENERATED, file=sys.stderr)


if __name__ == "__main__":
    main()

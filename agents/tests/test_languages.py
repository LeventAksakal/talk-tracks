"""One subtitle language list for the agents and the player (decision 0035): ``contracts/languages.json``."""

from __future__ import annotations

from talk_tracks import languages


def test_the_agents_language_list_is_generated_from_the_contracts_file() -> None:
    """``language_list.py`` is exactly what ``python -m talk_tracks.languages`` writes from the JSON: run it after
    editing ``contracts/languages.json``."""
    listed = languages.read_languages_json()
    assert languages.GENERATED.read_text(encoding="utf-8") == languages.render_language_list(listed)
    assert tuple(tag for tag, _ in listed) == languages.SUPPORTED_LANGUAGES
    assert dict(listed) == languages.LANGUAGE_NAMES


def test_the_list_has_each_language_once_under_a_valid_tag() -> None:
    tags = [tag for tag, _ in languages.read_languages_json()]
    assert len(tags) == len(set(tags)) > 0
    assert all(languages.BCP_47_RE.match(tag) and languages.is_supported_language(tag) for tag in tags)

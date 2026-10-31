"""Tests for Decision 0019: Subtitles translate into any language the Muse model supports (Any-language translation).

Requirements:
1. Allow translation tracks on demand for any BCP 47 language tag supported by Muse LLM
   (e.g. talk/<room>/agents/translate-<lang>), rather than hardcoding only tr, es, ar.
2. Ensure lazy activation via demand tracking (demand.py), so tracks only run and consume spend when subscribed.
3. Respect room spend ceilings.
4. Keep Python tests passing (pytest agents/tests).
5. Keep within agents/ and backend files only.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from collections.abc import AsyncGenerator, AsyncIterator
from pathlib import Path
from typing import Any

import jsonschema
import pytest

import talk_tracks
from talk_tracks import cli
from talk_tracks.archive.slices import SliceObject
from talk_tracks.contracts import Cue
from talk_tracks.cores.translate import TranslateCore
from talk_tracks.demand import Demand, Gate, gated
from talk_tracks.languages import (
    SUPPORTED_LANGUAGES,
    is_supported_language,
    language_name,
    parse_translation_agent,
    translation_agent_name,
)
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.llm.ledger import RoomCap, SpendLedger
from talk_tracks.llm.queued import Priority
from talk_tracks.records import carry_in, cues_of, encode, record
from talk_tracks.room_catalog import RoomCatalog, translation_track, translation_tracks
from talk_tracks.runtime import CaptionsObject, run_translate
from talk_tracks.schema import CONTRACTS_DIR

from .slicekit import archive, sliced


def schema_of(name: str) -> dict[str, Any]:
    return json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))


def cue(i: int) -> Cue:
    return Cue(start=i * 1000, end=i * 1000 + 900, id=str(i * 1000), text=f"cue {i}", final=True)


def captions_item(i: int) -> CaptionsObject:
    k = (i * 1000) // 4000
    return CaptionsObject(k, 1, [cue(i)])


def translated_cues(out: Any) -> list[Cue]:
    return [c for _, o, p in out.objects if o > 0 for c in cues_of(p)[1]]


# --- Requirement 1: Any BCP 47 Language Tag Support -----------------------------------------------------------


def test_muse_supported_languages_list() -> None:
    """Muse model supports 50 world languages with BCP 47 tags (decision 0019, ui-design §4.2)."""
    assert len(SUPPORTED_LANGUAGES) == 50
    # Core pre-made languages remain supported
    for lang in ("tr", "es", "ar"):
        assert lang in SUPPORTED_LANGUAGES
        assert is_supported_language(lang)

    # Any-language translation: German, French, Japanese, Chinese, Hindi, etc.
    for lang in ("de", "fr", "ja", "zh", "hi", "it", "nl", "ru", "ko", "uk", "vi"):
        assert lang in SUPPORTED_LANGUAGES
        assert is_supported_language(lang)

    # Regional / script BCP 47 tags whose primary language is supported
    assert is_supported_language("pt-BR")
    assert is_supported_language("zh-CN")
    assert is_supported_language("es-419")
    assert is_supported_language("en-US")

    # Invalid / empty tags
    assert not is_supported_language("")
    assert not is_supported_language("   ")
    assert not is_supported_language("123")
    assert not is_supported_language("invalid_tag!")


def test_language_names_autonyms_and_fallbacks() -> None:
    """English language names are provided for supported languages, with primary subtag fallback."""
    assert language_name("tr") == "Turkish"
    assert language_name("es") == "Spanish"
    assert language_name("ar") == "Arabic"
    assert language_name("de") == "German"
    assert language_name("fr") == "French"
    assert language_name("ja") == "Japanese"
    assert language_name("zh") == "Chinese"
    assert language_name("pt-BR") == "Portuguese"
    assert language_name("custom-lang") == "custom-lang"


def test_translation_agent_naming_helpers() -> None:
    assert translation_agent_name("de") == "translate-de"
    assert translation_agent_name("pt-BR") == "translate-pt-br"
    assert parse_translation_agent("translate-de") == "de"
    assert parse_translation_agent("translate-ar") == "ar"
    assert parse_translation_agent("captions") is None
    assert parse_translation_agent("describe") is None


def test_translate_core_supports_any_language() -> None:
    core_de = TranslateCore("de")
    assert core_de.lang == "de"
    assert core_de.is_supported

    core_ja = TranslateCore("ja")
    assert core_ja.lang == "ja"
    assert core_ja.is_supported

    c = cue(1)
    assert core_de.pending([c]) == [c]
    added = core_de.add(c, "German text")
    assert added.text == "German text"
    assert added.id == c.id
    assert core_de.carry() == [added]


async def test_run_translate_for_any_bcp47_language(tmp_path: Path) -> None:
    """Translation produces translated cues in any requested language (e.g. German 'de')."""

    async def objects() -> AsyncIterator[CaptionsObject | None]:
        yield captions_item(0)
        yield captions_item(1)

    llm = FakeLlm()
    track, out = sliced(tmp_path, "translate-de")
    core = TranslateCore("de")
    track.carry = core.carry
    await run_translate(objects(), llm, track, core)

    cues = translated_cues(out)
    assert len(cues) == 2
    assert [c.id for c in cues] == ["0", "1000"]
    assert llm.usage.requests == 2


# --- Requirement 2: Lazy Activation via Demand Tracking (demand.py) -------------------------------------------


class SwitchDemand(Demand):
    def __init__(self) -> None:
        super().__init__()
        self.is_wanted = False

    def wanted(self) -> bool:
        return self.is_wanted


async def test_lazy_activation_consumes_zero_spend_when_not_subscribed(tmp_path: Path) -> None:
    """A translation track stays completely idle without subscribers, spending $0 (decision 0010, 0019)."""
    demand = SwitchDemand()
    gate = Gate(demand, grace_s=0.05, poll_s=0.005)

    opened = False

    async def captions_source() -> AsyncGenerator[CaptionsObject | None]:
        nonlocal opened
        opened = True
        yield captions_item(0)

    track, out = sliced(tmp_path, "translate-fr")
    core = TranslateCore("fr")
    track.carry = core.carry
    llm = FakeLlm()

    async def runner() -> None:
        cues = gated(gate, captions_source, "translate-fr test", track.finish)
        async with asyncio.timeout(0.1):
            async for _ in cues:
                pass

    with pytest.raises(TimeoutError):
        await runner()

    # While not wanted, the input source was never even opened
    assert not opened
    assert llm.usage.requests == 0
    assert len(translated_cues(out)) == 0


async def test_lazy_activation_wakes_on_subscription_and_idles_when_last_leaves(tmp_path: Path) -> None:
    """Track wakes when subscribed and pauses after subscribers leave."""
    demand = SwitchDemand()
    gate = Gate(demand, grace_s=0.05, poll_s=0.005)

    cues_queue: asyncio.Queue[CaptionsObject | None] = asyncio.Queue()

    async def captions_stream() -> AsyncGenerator[CaptionsObject | None]:
        while True:
            item = await cues_queue.get()
            yield item

    track, out = sliced(tmp_path, "translate-ja")
    core = TranslateCore("ja")
    track.carry = core.carry
    llm = FakeLlm()

    task = asyncio.create_task(run_translate(gated(gate, captions_stream, "test-ja"), llm, track, core))

    # 1. Idle: no subscriber
    await asyncio.sleep(0.02)
    assert llm.usage.requests == 0

    # 2. Subscribed: wake up
    demand.is_wanted = True
    await asyncio.sleep(0.02)
    cues_queue.put_nowait(captions_item(1))
    await asyncio.sleep(0.05)
    assert [c.id for c in translated_cues(out)] == ["1000"]
    assert llm.usage.requests == 1

    # 3. Subscriber leaves: idles after grace
    demand.is_wanted = False
    await asyncio.sleep(0.1)
    assert track.paused

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# --- Requirement 3: Room Spend Ceilings -----------------------------------------------------------------------


async def test_translation_respects_room_spend_ceiling(tmp_path: Path) -> None:
    """Translation cuts off and marks track as capped when room budget is reached (decision 0008)."""
    ledger = SpendLedger(tmp_path / "ledger.jsonl", 100).for_room("room-any", RoomCap(0.02))
    llm = FakeLlm(ledger, usd_per_call=0.01)

    async def objects() -> AsyncIterator[CaptionsObject | None]:
        for n in range(5):
            yield captions_item(n)

    track, _ = sliced(tmp_path, "translate-nl")
    core = TranslateCore("nl")
    track.carry = core.carry

    await run_translate(objects(), llm, track, core)

    # Stopped at 2 calls = $0.02
    assert llm.usage.requests == 2
    assert track.capped
    assert ledger.room_total() == pytest.approx(0.02)


async def test_multiple_translations_share_same_room_ledger_and_cap_together(tmp_path: Path) -> None:
    """Multiple concurrent translations in a room draw from the same room ledger and ceiling."""
    room_ledger = SpendLedger(tmp_path / "ledger.jsonl", 100).for_room("shared-room", RoomCap(0.03))
    llm = FakeLlm(room_ledger, usd_per_call=0.01)

    # Track 1: German
    track_de, _ = sliced(tmp_path / "de", "translate-de")
    core_de = TranslateCore("de")
    track_de.carry = core_de.carry

    # Track 2: Italian
    track_it, _ = sliced(tmp_path / "it", "translate-it")
    core_it = TranslateCore("it")
    track_it.carry = core_it.carry

    async def de_objects() -> AsyncIterator[CaptionsObject | None]:
        yield captions_item(0)
        yield captions_item(1)

    async def it_objects() -> AsyncIterator[CaptionsObject | None]:
        yield captions_item(0)
        yield captions_item(1)

    # Run de (2 calls = $0.02)
    await run_translate(de_objects(), llm, track_de, core_de)
    assert llm.usage.requests == 2
    assert not track_de.capped

    # Run it (1 call succeeds = $0.03 total, 2nd call hits cap)
    await run_translate(it_objects(), llm, track_it, core_it)
    assert llm.usage.requests == 3
    assert track_it.capped
    assert room_ledger.room_total() == pytest.approx(0.03)


# --- MSF Catalog Compliance -----------------------------------------------------------------------------------


def test_translation_track_catalog_entry() -> None:
    """translation_track creates valid MSF catalog track metadata for any language."""
    track = translation_track("physics", "de", captions=["talk/physics/agents/captions/items"])
    assert track.namespace == "talk/physics/agents/translate-de"
    assert track.name == "items"
    assert track.kind == "translation"
    assert track.lang == "de"
    assert track.label == "German translation"
    assert track.cost == "paid"
    assert track.depends_on == ("talk/physics/agents/captions/items",)


def test_room_catalog_with_any_language_translations_validates_msf_schema() -> None:
    """Room catalog with multiple on-demand translation tracks conforms to room-catalog.schema.json."""
    room = "chem-101"
    tracks = translation_tracks(room, ["de", "fr", "ja", "zh"])
    assert len(tracks) == 4

    catalog = RoomCatalog(1_700_000_000_000, tracks, {100: 0}, {})
    doc: Any = catalog.to_json()
    jsonschema.validate(doc, schema_of("room-catalog.schema.json"))

    by_ns = {t["namespace"]: t for t in doc["tracks"]}
    assert "talk/chem-101/agents/translate-de" in by_ns
    assert "talk/chem-101/agents/translate-fr" in by_ns
    assert "talk/chem-101/agents/translate-ja" in by_ns
    assert "talk/chem-101/agents/translate-zh" in by_ns

    de = by_ns["talk/chem-101/agents/translate-de"]
    assert de["role"] == "subtitle"
    assert de["eventType"] == "urn:msf:captions:webvtt"
    assert de["lang"] == "de"
    assert de["label"] == "German translation"


# --- Back-fill and the per-room translation agent --------------------------------------------------------------


class CaptionsRelay:
    """The relay as back-fill sees it: FETCH of one captions slice, recorded."""

    def __init__(self, slices: dict[int, list[bytes]]) -> None:
        self.slices = slices
        self.fetched: list[tuple[str, str, int]] = []

    async def fetch_group(self, namespace: str, track: str, k: int) -> list[bytes]:
        self.fetched.append((namespace, track, k))
        return self.slices.get(k, [])


async def test_translation_back_fill_carries_in_the_end_of_the_slice_before(tmp_path: Path) -> None:
    """A FETCH for an unproduced translation slice translates its captions slice, carrying in the archived end of
    this track's slice before (the back-fill each translate-<lang> track serves, decision 0019)."""
    done = archive(tmp_path, "translate-de")
    earlier = cue(1).model_copy(update={"text": "[de] cue 1"})
    done.create(0, [SliceObject(0, carry_in(0, [])), SliceObject(1, encode([record(earlier)]))])
    relay = CaptionsRelay({1: [carry_in(1, [cue(3)]), encode([record(cue(4)), record(cue(5))])]})
    produce = cli.translation_backfill(relay, "room-1", "de", done, FakeLlm(), Priority())

    carry, made = await produce(1)

    assert relay.fetched == [("talk/room-1/agents/captions", "items", 1)]
    assert [c.text for c in carry] == ["[de] cue 1"]
    assert [c.id for c in made] == ["4000", "5000"] and made[0].text.startswith("[de] cue 4")
    with pytest.raises(LookupError, match="slice 2 is empty"):
        await produce(2)


async def test_translation_agent_imports_resolve_before_it_connects(monkeypatch: pytest.MonkeyPatch) -> None:
    """The per-room translation agent gets as far as connecting to the relay (its lazy imports all resolve).
    aiomoqt has no Windows wheels, so ``talk_tracks.moq`` is a stand-in whose connect refuses."""

    def refuse(*_: Any, **__: Any) -> Any:
        raise ConnectionRefusedError("no relay in tests")

    stand_in = types.ModuleType("talk_tracks.moq")
    stand_in.connect = refuse  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "talk_tracks.moq", stand_in)
    monkeypatch.setattr(talk_tracks, "moq", stand_in, raising=False)
    args = cli.parse(["translate", "--relay", "moqt://127.0.0.1:4443", "--room", "room-1", "--lang", "de", "--fake"])
    with pytest.raises(ConnectionRefusedError, match="no relay"):
        await cli.serve_translate_room(args, "room-1")

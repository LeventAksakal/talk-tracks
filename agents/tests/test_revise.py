# ruff: noqa: RUF001, RUF003  (Turkish, Spanish and Arabic text)
import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast

import httpx
import jsonschema
import pytest

from talk_tracks import cli, revise
from talk_tracks.contracts import (
    AgentInfo,
    CaptionLine,
    CaptionsState,
    Chapter,
    CueObject,
    CueRecord,
    OutlineState,
    SlideNote,
    SlidesState,
    TranslationState,
    Usage,
)
from talk_tracks.cores.translate import WINDOW
from talk_tracks.llm.fake import FakeLlm
from talk_tracks.llm.ledger import SpendLedger
from talk_tracks.recording import MANIFEST, RecordedSnapshot, RecordingWriter, load_manifest
from talk_tracks.replay import EPOCH_MS
from talk_tracks.resegment import MAX_CUE_CHARS, cue_texts, resegment
from talk_tracks.schema import CONTRACTS_DIR
from talk_tracks.slicing import Room, Template, room_catalog
from talk_tracks.slideshow import Crop, Slide

from .test_resegment import CAPTIONS
from .test_resegment import recording as long_line

SLIDES = AgentInfo(name="describe", label="Slides", model="fake")


def write(directory: Path, recorded: list[tuple[AgentInfo, list[RecordedSnapshot]]]) -> Path:
    rec = RecordingWriter(directory, "gen-test", wall_ms=0)
    for info, snapshots in recorded:
        for snap in snapshots:
            rec.add(info, snap.state, snap.usage, media_ms=snap.media_ms, wall_ms=0)
    rec.close(wall_ms=1)
    return directory


def snap(media_ms: int, state: SlidesState) -> RecordedSnapshot:
    return RecordedSnapshot(media_ms=media_ms, wall_ms=0, instance="1", seq=0, usage=Usage(), state=state)


def note(i: int, at_ms: int) -> SlideNote:
    return SlideNote(id=i, at_ms=at_ms, description=f"slide {i}")


def test_retranslate_saves_one_segment_per_cue_and_the_loop_uses_them(tmp_path: Path) -> None:
    directory = write(tmp_path, long_line())
    saved = asyncio.run(revise.retranslate(directory, revise.FakeCueTranslator()))
    cues = cue_texts(revise.read_recording(directory))[0]
    assert saved.lines[0].segments == [f"[tr] {c}" for c in cues]
    assert saved.usage.requests == 1
    recorded = revise.read_recording(directory)
    (_, caps), (_, tr) = resegment(recorded, revise.translations_by_agent(directory, recorded))
    last = tr[-1].state
    assert isinstance(last, TranslationState) and isinstance(caps[-1].state, CaptionsState)
    assert [line.text for line in last.lines] == saved.lines[0].segments
    assert [line.id for line in last.lines] == [c.id for c in caps[-1].state.lines]


def test_saved_segments_for_other_cues_fall_back_to_the_split(tmp_path: Path) -> None:
    directory = write(tmp_path, long_line())
    saved = asyncio.run(revise.retranslate(directory, revise.FakeCueTranslator()))
    stale = saved.model_copy(update={"lines": {0: saved.lines[0].model_copy(update={"cues": ["another cut"]})}})
    revise.cues_path(directory, "translate-tr").write_text(stale.model_dump_json(), encoding="utf-8")
    recorded = revise.read_recording(directory)
    _, (_, tr) = resegment(recorded, revise.translations_by_agent(directory, recorded))
    last = tr[-1].state
    assert isinstance(last, TranslationState)
    assert not any(line.text.startswith("[tr]") for line in last.lines)


def test_redescribe_describes_only_the_slides_without_a_note(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    states = [
        snap(3_000, SlidesState(lang="en", slides=[note(0, 0)])),
        snap(20_000, SlidesState(lang="en", slides=[note(0, 0), note(2, 15_000)])),
    ]
    directory = write(tmp_path, [(SLIDES, states)])
    found = [Slide(0, b"a"), Slide(8_000, b"b"), Slide(15_000, b"c"), Slide(30_000, b"d")]

    def find(media: Path, crop: Crop | None = None) -> list[Slide]:
        return found

    monkeypatch.setattr(revise, "find_slides", find)
    patch = asyncio.run(revise.redescribe(directory, directory / "lecture.mp4", Crop(), FakeLlm()))
    assert [(n.id, n.at_ms) for n in patch.notes] == [(1, 8_000), (3, 30_000)]
    merged = revise.with_patches(directory, revise.read_recording(directory))[0][1]
    assert [s.media_ms for s in merged] == [3_000, 12_000, 20_000, 34_000]
    ids: list[list[int]] = []
    for s in merged:
        assert isinstance(s.state, SlidesState)
        ids.append([n.id for n in s.state.slides])
    assert ids == [[0], [0, 1], [0, 1, 2], [0, 1, 2, 3]]


def test_the_meta_cue_translator_asks_for_one_segment_per_cue(tmp_path: Path) -> None:
    sent: list[dict[str, Any]] = []

    def reply(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        content = json.dumps({"segments": ["bir", "iki"]})
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 300, "completion_tokens": 100},
            },
        )

    ledger = SpendLedger(tmp_path / "ledger.jsonl", 1.0)
    client = httpx.AsyncClient(transport=httpx.MockTransport(reply))
    translator = revise.MetaCueTranslator("key", ledger, base_url="http://127.0.0.1/v1", client=client)
    segments = asyncio.run(translator.translate_cues(["one", "two"], lang="tr", context=["before"]))
    assert segments == ["bir", "iki"]
    assert sent[0]["response_format"]["json_schema"]["schema"] == revise.CUES_SCHEMA
    assert "1. one\n2. two" in sent[0]["messages"][1]["content"]
    assert ledger.total() == pytest.approx(translator.usage.cost_usd) and translator.usage.requests == 1


# Turkish cut unevenly over three English cues, as retranslate's model did: the middle segment runs over 84.
TR_CUES = [
    "I'm not going to talk about disease.",
    "I am absolutely not qualified to diagnose any disease, to advise on treatment,",
    "to talk about degrees disease progression, anything like that.",
]
TR_SEGMENTS = [
    "Hastalıktan bahsetmeyeceğim.",
    "Herhangi bir hastalığı teşhis etme, tedavi önerme konusunda kesinlikle yetkin değilim,",
    "hastalığın ilerleme dereceleri hakkında konuşma, böyle şeyler.",
]


def words_of(segments: list[str]) -> list[str]:
    return " ".join(segments).split()


@pytest.mark.parametrize("anchor", ["model", "share"])
def test_resplit_line_fits_every_cue_and_keeps_the_words_in_order(anchor: revise.Anchor) -> None:
    assert max(len(s) for s in TR_SEGMENTS) > MAX_CUE_CHARS
    out = revise.resplit_line(TR_CUES, TR_SEGMENTS, anchor=anchor)
    assert len(out) == len(TR_CUES) and all(out)
    assert max(len(s) for s in out) <= MAX_CUE_CHARS
    assert words_of(out) == words_of(TR_SEGMENTS)


def test_resplit_line_moves_only_the_words_it_must_by_default() -> None:
    out = revise.resplit_line(TR_CUES, TR_SEGMENTS)
    assert out == [TR_SEGMENTS[0], TR_SEGMENTS[1].removesuffix(" değilim,"), "değilim, " + TR_SEGMENTS[2]]


def test_resplit_line_by_share_breaks_after_punctuation_near_the_share() -> None:
    # equal cues put the share point between "beş" and "altı"; the sentence end a word earlier wins
    out = revise.resplit_line(
        ["a" * 40, "b" * 40], ["Bir iki üç dört. Beş altı yedi", "sekiz dokuz on"], anchor="share"
    )
    assert out == ["Bir iki üç dört.", "Beş altı yedi sekiz dokuz on"]


def test_resplit_line_keeps_the_overflow_least_when_the_line_cannot_fit() -> None:
    long = "çok " * 60  # 239 characters, with "son" 243, over two cues of 84
    out = revise.resplit_line(["one", "two"], [long, "son"])
    assert words_of(out) == words_of([long, "son"])
    assert revise.overflow(out) == 243 - 1 - 2 * MAX_CUE_CHARS


def test_resplit_line_leaves_a_line_with_too_few_words() -> None:
    assert revise.resplit_line(["one", "two", "three"], ["iki", "kelime"]) == ["iki", "kelime"]


def test_resplit_rewrites_the_saved_cues_keeps_the_original_and_is_idempotent(tmp_path: Path) -> None:
    (tmp_path / "agents").mkdir()
    fine = revise.CueTranslation(cues=["Good morning."], segments=["Günaydın."])
    saved = revise.CueTranslations(
        lang="tr",
        model="m",
        usage=Usage(requests=2),
        lines={0: fine, 3: revise.CueTranslation(cues=TR_CUES, segments=TR_SEGMENTS)},
    )
    path = revise.cues_path(tmp_path, "translate-tr")
    path.write_text(saved.model_dump_json(), encoding="utf-8")
    result, changed = revise.resplit(tmp_path)
    assert changed == [3]
    assert result.lines[0] == fine and result.usage == saved.usage
    assert result.lines[3].cues == TR_CUES  # the cues, and so their timing, stay
    assert max(len(s) for s in result.lines[3].segments) <= MAX_CUE_CHARS
    assert words_of(result.lines[3].segments) == words_of(TR_SEGMENTS)
    assert revise.load_cue_translations(tmp_path) == {
        0: (("Good morning.",), ("Günaydın.",)),
        3: (tuple(TR_CUES), tuple(result.lines[3].segments)),
    }
    backup = tmp_path / "agents" / "translate-tr.cues.orig.json"
    assert revise.CueTranslations.model_validate_json(backup.read_text(encoding="utf-8")) == saved
    first = path.read_text(encoding="utf-8")
    again, changed = revise.resplit(tmp_path)
    assert changed == [] and again == result and path.read_text(encoding="utf-8") == first
    assert revise.CueTranslations.model_validate_json(backup.read_text(encoding="utf-8")) == saved


AR_SEGMENTS = [
    "لن أتحدث عن الأمراض اليوم؟",
    "لست مؤهلاً على الإطلاق لتشخيص أي مرض، أو تقديم نصيحة علاجية؛ أو مناقشة مراحل تطور المرض بالتفصيل،",
    "أو أي شيء من هذا القبيل.",
]

ES_SEGMENTS = [
    "No voy a hablar de enfermedades.",
    "¿Acaso estoy cualificado para diagnosticar enfermedades, aconsejar tratamientos o evaluar casos clínicos,",
    "¡ni nada parecido hoy!?",
]


def test_resplit_line_recognises_arabic_and_spanish_punctuation() -> None:
    # Arabic question mark (U+061F) earns SENTENCE_BONUS (6) near the share point (target 22: pos 17 vs 23).
    ar_q = revise.resplit_line(
        ["a" * 40, "b" * 40],
        ["واحد اثنان ثلاثة؟ أربعة خمسة ستة", "سبعة ثمانية"],
        anchor="share",
    )
    assert ar_q == ["واحد اثنان ثلاثة؟", "أربعة خمسة ستة سبعة ثمانية"]

    # Arabic comma (U+060C) and semicolon (U+061B) earn CLAUSE_BONUS (3) near the share point (target 22: pos 20 vs 23).
    for mark in ("،", "؛"):
        ar_c = revise.resplit_line(
            ["a" * 40, "b" * 40],
            [f"واحد اثنان ثلاثون12{mark} أب", "جدة خمسة ستة سبعة ثمانية1"],
            anchor="share",
        )
        assert ar_c[0].endswith(mark)

    # Over-84-character Arabic and Spanish segments fit within MAX_CUE_CHARS without losing or splitting words.
    assert max(len(s) for s in AR_SEGMENTS) > MAX_CUE_CHARS
    ar_out = revise.resplit_line(TR_CUES, AR_SEGMENTS)
    assert len(ar_out) == len(TR_CUES) and max(len(s) for s in ar_out) <= MAX_CUE_CHARS
    assert words_of(ar_out) == words_of(AR_SEGMENTS)

    assert max(len(s) for s in ES_SEGMENTS) > MAX_CUE_CHARS
    es_out = revise.resplit_line(TR_CUES, ES_SEGMENTS)
    assert len(es_out) == len(TR_CUES) and max(len(s) for s in es_out) <= MAX_CUE_CHARS
    assert words_of(es_out) == words_of(ES_SEGMENTS)
    assert any("¿Acaso" in s for s in es_out) and any("¡ni" in s for s in es_out)

    # Spanish inverted question mark breaks cleanly before "¿por" rather than stranding "¿por" in cue 1.
    es_q = revise.resplit_line(
        ["a" * 40, "b" * 40],
        ["Uno dos tres cuatro ¿por qué pasa", "ahora mismo"],
        anchor="share",
    )
    assert es_q == ["Uno dos tres cuatro", "¿por qué pasa ahora mismo"]


class _OverflowTranslator:
    """Fake offline translator returning realistic per-language segments, with one over-84-char cue to resplit."""

    def __init__(self, usd_per_call: float) -> None:
        self._requests = 0
        self._usd = usd_per_call

    @property
    def model(self) -> str:
        return "fake-overflow"

    @property
    def usage(self) -> Usage:
        return Usage(
            requests=self._requests,
            input_tokens=self._requests * 200,
            output_tokens=self._requests * 80,
            cost_usd=round(self._requests * self._usd, 6),
        )

    async def translate_cues(self, cues: Sequence[str], *, lang: str, context: Sequence[str]) -> list[str]:
        self._requests += 1
        word = "palabra" if lang == "es" else "كلمة" if lang == "ar" else "kelime"
        out = [f"[{lang}] {word} {i}" for i in range(len(cues))]
        if len(out) >= 2:
            out[0] = " ".join([word] * 20)  # > 84 characters across 20 short words, easily resplit across cues
        return out


def _schema(name: str) -> dict[str, Any]:
    return json.loads((CONTRACTS_DIR / name).read_text(encoding="utf-8"))


def test_offline_retranslate_and_resplit_add_es_and_ar_and_produce_valid_msf_tracks(tmp_path: Path) -> None:
    chapters_info = AgentInfo(name="chapters", label="Chapters", model="fake")
    base = [
        *long_line(),
        (SLIDES, [snap(5_000, SlidesState(lang="en", slides=[note(0, 1_000)]))]),
        (
            chapters_info,
            [
                RecordedSnapshot(
                    media_ms=6_000,
                    wall_ms=0,
                    instance="1",
                    seq=0,
                    usage=Usage(),
                    state=OutlineState(
                        lang="en", chapters=[Chapter(id=0, start_ms=0, title="Intro", summary="S")], glossary=[]
                    ),
                )
            ],
        ),
    ]
    rec = RecordingWriter(tmp_path, "gen-virus", wall_ms=10, media="lecture.mp4")
    rec.media_seen(0)
    rec.media_seen(34_500)  # clamps offline translation timestamp: 33_500 + 2_000 -> 34_500
    for info, snapshots in base:
        for s in snapshots:
            rec.add(info, s.state, s.usage, media_ms=s.media_ms, wall_ms=15)
    rec.close(wall_ms=20)
    tr_jsonl_before = (tmp_path / "agents" / "translate-tr.jsonl").read_text(encoding="utf-8")

    # Existing live translate-tr gets cue-aligned segments without rewriting its live .jsonl; es and ar are synthesised.
    asyncio.run(revise.retranslate(tmp_path, revise.FakeCueTranslator(), lang="tr"))
    es_saved = asyncio.run(revise.retranslate(tmp_path, _OverflowTranslator(0.075), lang="es"))
    ar_saved = asyncio.run(revise.retranslate(tmp_path, _OverflowTranslator(0.09), agent="translate-ar"))
    assert revise.overflow(es_saved.lines[0].segments) > 0
    assert revise.overflow(ar_saved.lines[0].segments) > 0

    es_resplit, es_changed = revise.resplit(tmp_path, lang="es")
    ar_resplit, ar_changed = revise.resplit(tmp_path, agent="translate-ar")
    assert es_changed == [0] and ar_changed == [0]
    assert max(len(s) for s in es_resplit.lines[0].segments) <= MAX_CUE_CHARS
    assert max(len(s) for s in ar_resplit.lines[0].segments) <= MAX_CUE_CHARS
    assert (tmp_path / "agents" / "translate-es.cues.orig.json").exists()
    assert (tmp_path / "agents" / "translate-ar.cues.orig.json").exists()
    assert (tmp_path / "agents" / "translate-tr.jsonl").read_text(encoding="utf-8") == tr_jsonl_before

    # Manifest and JSONL files validate against contracts/ schemas.
    manifest = load_manifest(tmp_path)
    assert [a.info.name for a in manifest.agents] == [
        "captions",
        "translate-tr",
        "translate-es",
        "translate-ar",
        "describe",
        "chapters",
    ]
    by_name = {a.info.name: a for a in manifest.agents}
    assert by_name["translate-es"].info.label == "Spanish translation"
    assert by_name["translate-ar"].info.label == "Arabic translation"
    assert by_name["translate-es"].first_media_ms == 34_500 and by_name["translate-es"].last_media_ms == 34_500
    jsonschema.validate(json.loads((tmp_path / MANIFEST).read_text(encoding="utf-8")), _schema("recording.schema.json"))
    snap_schema = _schema("recorded-snapshot.schema.json")
    for name in ("translate-es", "translate-ar"):
        lines = (tmp_path / "agents" / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
        assert len(lines) == 1
        for raw_line in lines:
            jsonschema.validate(json.loads(raw_line), snap_schema)

    # Full pipeline: read_recording -> with_patches -> resegment -> Template.build -> Room -> room_catalog.
    raw_recorded = revise.with_patches(tmp_path, revise.read_recording(tmp_path))
    resegmented = resegment(raw_recorded, revise.translations_by_agent(tmp_path, raw_recorded))
    template = Template.build(resegmented, 36_000)
    room = Room(template, EPOCH_MS)
    cat = room_catalog(template, "virus", EPOCH_MS, 212_976_000_000_000, now_ms=100).to_json()
    jsonschema.validate(cat, _schema("room-catalog.schema.json"))

    tracks = {t["namespace"]: t for t in cast(list[dict[str, Any]], cat["tracks"])}
    status = cast(dict[str, Any], cat["tt"])["status"]
    for code, label, expected_spend in (
        ("tr", "Turkish", 0.0),
        ("es", "Spanish translation", 0.075),
        ("ar", "Arabic translation", 0.09),
    ):
        ns = f"talk/virus/agents/translate-{code}"
        entry = tracks[ns]
        assert entry["role"] == "subtitle"
        assert entry["lang"] == code
        assert entry["label"] == label
        assert entry["tt"]["dependsOn"] == ["talk/virus/agents/captions/items"]
        assert entry["tt"]["cost"] == "free"
        assert status[f"translate-{code}"]["spend_usd"] == pytest.approx(expected_spend)

    # Every 4 s slice and FETCH payload of captions, translate-tr, translate-es, translate-ar is valid MSF.
    cue_schema = _schema("cue-object.schema.json")
    cap_ids = {
        r.data.id
        for g in range(room.per_loop("captions"))
        for p in room.group("captions", g)[1:]
        for r in CueObject.model_validate_json(p.payload).root
        if isinstance(r, CueRecord) and r.data.final
    }
    assert len(cap_ids) >= 4
    for agent_name in ("translate-tr", "translate-es", "translate-ar"):
        assert room.per_loop(agent_name) == 9  # 36 s / 4 s slices
        seen_ids: set[str] = set()
        for g in range(room.per_loop(agent_name)):
            placed = room.group(agent_name, g)
            fetched = room.published(agent_name, g, 36_000)
            assert [p.payload for p in placed] == [p.payload for p in fetched]
            for idx, p in enumerate(placed):
                jsonschema.validate(json.loads(p.payload), cue_schema)
                records = [r for r in CueObject.model_validate_json(p.payload).root if isinstance(r, CueRecord)]
                for r in records:
                    assert len(r.data.text) <= MAX_CUE_CHARS
                    if idx > 0:
                        seen_ids.add(r.data.id)
        assert seen_ids == cap_ids


def test_offline_retranslate_captions_only_rolling_window_and_idempotence(tmp_path: Path) -> None:
    total_lines = WINDOW + 5
    rec = RecordingWriter(tmp_path, "gen-only-caps", wall_ms=100, media="lecture.mp4")
    built: list[CaptionLine] = []
    for i in range(total_lines):
        built.append(CaptionLine(id=i, start_ms=i * 1_000, end_ms=i * 1_000 + 800, text=f"Short spoken line {i}."))
        rec.add(
            CAPTIONS,
            CaptionsState(lang="en", lines=built[-WINDOW:]),
            Usage(),
            media_ms=i * 1_000 + 850,
            wall_ms=100 + i,
        )
    rec.close(wall_ms=500)

    # First offline synthesis on a captions-only recording.
    asyncio.run(revise.retranslate(tmp_path, revise.FakeCueTranslator(usd_per_call=0.001), lang="es"))
    asyncio.run(revise.retranslate(tmp_path, revise.FakeCueTranslator(usd_per_call=0.002), lang="ar"))

    manifest_raw = (tmp_path / MANIFEST).read_text(encoding="utf-8")
    es_jsonl_raw = (tmp_path / "agents" / "translate-es.jsonl").read_text(encoding="utf-8")
    es_cues_raw = revise.cues_path(tmp_path, "translate-es").read_text(encoding="utf-8")

    es_snaps = {info.name: s for info, s in revise.read_recording(tmp_path)}["translate-es"]
    assert len(es_snaps) == total_lines
    last_state = es_snaps[-1].state
    assert isinstance(last_state, TranslationState)
    assert len(last_state.lines) == WINDOW  # rolling window matches TranslateCore
    assert [line.id for line in last_state.lines] == list(range(total_lines - WINDOW, total_lines))
    assert es_snaps[-1].usage.cost_usd == pytest.approx(total_lines * 0.001)

    # All 45 cues still slice cleanly despite the 40-line rolling window.
    recorded = revise.read_recording(tmp_path)
    template = Template.build(
        resegment(recorded, revise.translations_by_agent(tmp_path, recorded)), total_lines * 1_000
    )
    es_sliced = next(a for a in template.agents if a.info.name == "translate-es")
    assert es_sliced.spend_usd() == pytest.approx(total_lines * 0.001)

    # Re-running retranslate for the same language is idempotent (no duplicate manifest entries, identical files).
    asyncio.run(revise.retranslate(tmp_path, revise.FakeCueTranslator(usd_per_call=0.001), lang="es"))
    assert [a.info.name for a in load_manifest(tmp_path).agents] == ["captions", "translate-es", "translate-ar"]
    assert (tmp_path / MANIFEST).read_text(encoding="utf-8") == manifest_raw
    assert (tmp_path / "agents" / "translate-es.jsonl").read_text(encoding="utf-8") == es_jsonl_raw
    assert revise.cues_path(tmp_path, "translate-es").read_text(encoding="utf-8") == es_cues_raw


def test_cli_retranslate_and_resplit_accept_lang_and_agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TT_ROOM", raising=False)
    monkeypatch.delenv("TT_RELAY", raising=False)
    caps_only = [long_line()[0]]
    write(tmp_path, caps_only)

    # Non-revise commands still default --lang to "en"; revise commands leave --lang None unless given.
    assert cli.parse(["captions", "--relay", "moqt://127.0.0.1:4443", "--room", "live"]).lang == "en"
    assert cli.parse(["retranslate", "--recording", str(tmp_path), "--room", "revise-tr"]).lang is None

    asyncio.run(
        cli.main_async(
            cli.parse(["retranslate", "--recording", str(tmp_path), "--lang", "es", "--room", "revise-es", "--fake"])
        )
    )
    asyncio.run(
        cli.main_async(
            cli.parse(
                [
                    "retranslate",
                    "--recording",
                    str(tmp_path),
                    "--agent",
                    "translate-ar",
                    "--room",
                    "revise-ar",
                    "--fake",
                ]
            )
        )
    )
    # resplit needs neither --relay nor --room, and accepts both --lang and --agent.
    asyncio.run(cli.main_async(cli.parse(["resplit", "--recording", str(tmp_path), "--lang", "es"])))
    asyncio.run(cli.main_async(cli.parse(["resplit", "--recording", str(tmp_path), "--agent", "translate-ar"])))

    assert [a.info.name for a in load_manifest(tmp_path).agents] == ["captions", "translate-es", "translate-ar"]
    assert revise.load_cue_translations(tmp_path, "translate-es") is not None
    assert revise.load_cue_translations(tmp_path, "translate-ar") is not None

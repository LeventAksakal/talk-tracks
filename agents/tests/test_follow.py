from talk_tracks.contracts import (
    CaptionsState,
    Cue,
    CueObject,
    CueRecord,
    OutlineState,
    RoomCatalog,
    SlidesState,
    State,
    TranslationState,
)
from talk_tracks.follow import TrackFollower, catalog_tracks, line_id
from talk_tracks.slicing import Room, room_catalog

from .test_slicing import EPOCH, template


def cue(i: str, rev: int, final: bool, text: str = "") -> bytes:
    data = Cue(start=1000, end=2000, id=i, text=text or f"cue {i} rev {rev}", rev=rev, final=final)
    return CueObject([CueRecord(m=1000, data=data)]).model_dump_json(by_alias=True).encode()


def test_the_catalog_lists_each_agent_track_with_what_a_follower_needs() -> None:
    doc = room_catalog(template(), "r", EPOCH, 7, 0).to_json()
    tracks = {t.agent: t for t in catalog_tracks(RoomCatalog.model_validate(doc))}
    assert {a: t.kind for a, t in tracks.items()} == {
        "captions": "captions",
        "translate-tr": "translation",
        "describe": "slides",
        "chapters": "outline",
    }
    assert tracks["translate-tr"].lang == "tr" and tracks["captions"].namespace == "talk/r/agents/captions"


def test_a_cue_ids_highest_rev_wins_and_the_newest_open_cue_is_the_interim() -> None:
    f = TrackFollower("captions", "en")
    first = f.accept(cue("4", 0, False, "hel"))
    assert isinstance(first, CaptionsState) and first.lines == [] and first.interim == "hel"
    assert f.accept(cue("4", 0, False, "hel")) is None  # a repeated object changes nothing
    done = f.accept(cue("4", 1, True, "hello"))
    assert isinstance(done, CaptionsState) and [(x.id, x.text) for x in done.lines] == [(4, "hello")]
    assert done.interim == ""
    assert f.accept(cue("4", 0, False, "hel")) is None  # an older revision arriving late


def test_a_whole_loop_of_room_objects_rebuilds_each_agents_last_state() -> None:
    room = Room(template(), EPOCH)
    doc = room_catalog(room.template, "r", EPOCH, 7, 0).to_json()
    states: dict[str, State | None] = {}
    for track in catalog_tracks(RoomCatalog.model_validate(doc)):
        f = TrackFollower(track.kind, track.lang)
        agent = next(a for a in room.template.agents if a.info.name == track.agent)
        for g in range(room.per_loop(agent.info.name)):
            for placed in room.group(agent.info.name, g):
                states[track.agent] = f.accept(placed.payload) or states.get(track.agent)
    captions = states["captions"]
    assert isinstance(captions, CaptionsState)
    assert [x.text for x in captions.lines] == [f"line {i}" for i in range(5)]
    translation = states["translate-tr"]
    assert isinstance(translation, TranslationState) and [x.text for x in translation.lines] == ["satir 0"]
    slides = states["describe"]
    assert isinstance(slides, SlidesState) and [s.description for s in slides.slides] == ["title"]
    outline = states["chapters"]
    assert isinstance(outline, OutlineState) and [c.title for c in outline.chapters] == ["A"]


def test_a_cue_id_that_is_not_a_number_gets_the_next_free_line_id() -> None:
    known: dict[str, int] = {}
    assert line_id("12", known) == 12
    assert line_id("a", known) == 0 and line_id("b", known) == 1 and line_id("a", known) == 0

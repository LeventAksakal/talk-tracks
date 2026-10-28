import json
from typing import Any, cast

from talk_tracks.contracts import (
    AgentInfo,
    CaptionLine,
    CaptionsState,
    Chapter,
    OutlineState,
    SlideNote,
    SlidesState,
    State,
    TranslatedLine,
    TranslationState,
    Usage,
)
from talk_tracks.lecture import MediaPacket
from talk_tracks.recording import RecordedSnapshot
from talk_tracks.replay import event_us, loop_events
from talk_tracks.slicing import (
    SLICED,
    CaptionItem,
    CaptionsCarry,
    OutlineSnapshot,
    Room,
    SlideItem,
    SlidesCarry,
    Template,
    TranslationCarry,
    TranslationItem,
    cues,
    period_of,
    room_catalog,
)

CAPTIONS = AgentInfo(name="captions", label="Captions (English)", model="fake")
TRANSLATE = AgentInfo(name="translate-tr", label="Turkish translation", model="fake")
SLIDES = AgentInfo(name="describe", label="Slides", model="fake")
CHAPTERS = AgentInfo(name="chapters", label="Chapters", model="fake")
DURATION = 9_000  # three slices a loop: 0-4, 4-8, 8-12 s (the lecture ends at 9 s)
EPOCH = 1_000_000


def snap(media_ms: int, state: State, cost: float = 0.0) -> RecordedSnapshot:
    return RecordedSnapshot(media_ms=media_ms, wall_ms=0, instance="1", seq=0, usage=Usage(cost_usd=cost), state=state)


def line(i: int) -> CaptionLine:
    return CaptionLine(id=i, start_ms=i * 1500, end_ms=i * 1500 + 1000, text=f"line {i}")


def caps(*ids: int, interim: str = "") -> CaptionsState:
    return CaptionsState(lang="en", lines=[line(i) for i in ids], interim=interim)


def recording() -> list[tuple[AgentInfo, list[RecordedSnapshot]]]:
    return [
        (
            CAPTIONS,
            [
                snap(0, caps()),
                snap(500, caps(interim="line")),
                snap(1200, caps(0)),
                snap(2000, caps(0, 1)),
                snap(3000, caps(0, 1, 2), cost=0.25),
                snap(4500, caps(0, 1, 2, interim="li")),
                snap(5000, caps(0, 1, 2, 3)),
                snap(30_000, caps(0, 1, 2, 3, 4)),  # recorded after the lecture: the last slice
            ],
        ),
        (
            TRANSLATE,
            [
                snap(0, TranslationState(lang="tr", lines=[])),
                snap(2500, TranslationState(lang="tr", lines=[TranslatedLine(id=0, text="satir 0")])),
            ],
        ),
        (
            SLIDES,
            [
                snap(1000, SlidesState(lang="en", slides=[SlideNote(id=0, at_ms=200, description="title")])),
                snap(6000, SlidesState(lang="en", slides=[SlideNote(id=0, at_ms=200, description="title")])),
            ],
        ),
        (
            CHAPTERS,
            [
                snap(100, OutlineState(lang="en", chapters=[], glossary=[])),
                snap(
                    3000,
                    OutlineState(lang="en", chapters=[Chapter(id=0, start_ms=0, title="A", summary="")], glossary=[]),
                ),
                snap(
                    3500,
                    OutlineState(lang="en", chapters=[Chapter(id=0, start_ms=0, title="A", summary="")], glossary=[]),
                ),
            ],
        ),
    ]


def template() -> Template:
    return Template.build(recording(), DURATION)


def bodies(t: Template, agent: str, j: int) -> list[object]:
    track = next(a for a in t.agents if a.info.name == agent)
    return [s.body for s in track.groups[j]]


def test_a_loop_is_the_lecture_in_whole_slices() -> None:
    assert period_of(9_000) == 12_000 and period_of(8_000) == 8_000 and period_of(1) == 4_000
    t = template()
    assert (t.period_ms, t.stride) == (12_000, 5)  # caption ids 0..4
    assert {a.info.name: (a.track, len(a.groups)) for a in t.agents} == {
        "captions": ("items", 3),
        "translate-tr": ("items", 3),
        "describe": ("items", 3),
        "chapters": ("outline", 2),  # the repeated revision is not a new group
    }


def test_captions_slice_into_a_carry_in_and_items() -> None:
    t = template()
    first = bodies(t, "captions", 0)
    assert first[0] == CaptionsCarry(lang="en", lines=[])
    items = [b for b in first[1:] if isinstance(b, CaptionItem)]
    assert [(i.line.id, i.final, i.line.text) for i in items] == [
        (0, False, "line"),  # an interim version of the next line, replaced by the final one
        (0, True, "line 0"),
        (1, True, "line 1"),
        (2, True, "line 2"),
    ]
    second = bodies(t, "captions", 1)
    assert second[0] == CaptionsCarry(lang="en", lines=[line(1), line(2)])  # the last two final lines
    interim = second[1]
    assert isinstance(interim, CaptionItem) and (interim.line.id, interim.final) == (3, False)
    assert (interim.line.start_ms, interim.line.end_ms) == (line(2).end_ms, 4500)
    last = bodies(t, "captions", 2)
    assert [b.line.id for b in last[1:] if isinstance(b, CaptionItem)] == [4]  # clamped to the loop's end
    carry = next(a for a in t.agents if a.info.name == "captions").groups[1][0]
    assert carry.at_ms == 4000 and carry.usage.cost_usd == 0.25


def test_translation_carries_its_source_lines_times_and_slides_their_screen() -> None:
    t = template()
    item = bodies(t, "translate-tr", 0)[1]
    assert isinstance(item, TranslationItem)
    assert (item.line.id, item.line.start_ms, item.line.end_ms) == (0, 0, 1000)
    carry = bodies(t, "translate-tr", 1)[0]
    assert isinstance(carry, TranslationCarry) and [x.text for x in carry.lines] == ["satir 0"]
    assert isinstance(bodies(t, "describe", 0)[1], SlideItem)
    assert len(bodies(t, "describe", 1)) == 1  # an unchanged description is not a new item
    carry = bodies(t, "describe", 2)[0]
    assert isinstance(carry, SlidesCarry) and carry.slide is not None and carry.slide.description == "title"


def test_room_groups_move_by_whole_loops_and_are_byte_identical() -> None:
    room = Room(template(), EPOCH)
    g = 2 * 3 + 1  # loop 2, slice 1
    objects = room.group("captions", g)
    again = room.group("captions", g)
    assert [o.payload for o in objects] == [o.payload for o in again]
    envelopes = [SLICED.validate_json(o.payload) for o in objects]
    assert [e.kind for e in envelopes] == ["carry", "item", "item"]
    assert {e.slice for e in envelopes} == {g}  # on an items track the group is the slice of its media time
    assert objects[0].media_ms == 2 * 12_000 + 4000 and envelopes[0].at_ms == EPOCH + 28_000
    carry = envelopes[0].body
    assert isinstance(carry, CaptionsCarry) and [x.id for x in carry.lines] == [11, 12]  # ids move by 2 x stride
    assert carry.lines[0].start_ms == 24_000 + line(1).start_ms
    wire = json.loads(objects[1].payload)
    assert wire["v"] == 2 and "seq" not in wire and "instance" not in wire and wire["body"]["type"] == "caption"


def test_a_group_fills_as_the_room_clock_passes() -> None:
    room = Room(template(), EPOCH)
    g = 3 + 1  # loop 1, slice 1: media 16..20 s
    assert room.published("captions", g, 15_999) == ()
    assert len(room.published("captions", g, 16_000)) == 1  # the carry-in, at the slice start
    assert room.current("captions", 17_000) == g
    # The outline: one group per revision, loop after loop.
    assert room.current("chapters", 50) is None
    assert room.current("chapters", 2000) == 0 and room.current("chapters", 3000) == 1
    assert room.current("chapters", 12_050) == 1  # loop 1 has no revision out yet: loop 0's last still holds
    assert room.current("chapters", 12_100) == 2
    outline = SLICED.validate_json(room.group("chapters", 3)[0].payload)
    assert outline.kind == "snapshot" and isinstance(outline.body, OutlineSnapshot)
    assert outline.slice == (12_000 + 3000) // 4000 and outline.body.chapters[0].id == 5


def test_cues_open_each_group_before_its_items_on_the_lecture_clock() -> None:
    t = template()
    loop = list(cues(t, 1))
    times = [c.at_ms for c in loop]
    assert times == sorted(times)
    opened: set[tuple[str, int]] = set()
    for c in loop:
        assert (c.index == 0) == ((c.agent, c.group) not in opened)
        opened.add((c.agent, c.group))
    assert {c.group for c in loop if c.agent == "captions"} == {3, 4, 5}
    assert {c.group for c in loop if c.agent == "chapters"} == {2, 3}
    media = [MediaPacket("video", us, us % 1_000_000 == 0, b"") for us in range(0, 9_000_000, 500_000)]
    events = list(loop_events(media, loop))
    assert [event_us(e) for e in events] == sorted(event_us(e) for e in events)
    at_four = [type(e).__name__ for e in events if event_us(e) == 4_000_000]
    assert at_four[-1] == "MediaPacket"  # a slice's carry-in goes out before the frame of the same instant


def test_the_room_catalog_lists_every_track_on_the_room_clock() -> None:
    root = room_catalog(template(), "virus", 1_790_812_800_000, 212_976_000_000_000).to_json()
    assert root["version"] == "draft-01"
    assert root["tt"] == {
        "epoch": 1_790_812_800_000,
        "shift": {"212976000000000": 0},
        "status": {
            name: {"producing": True, "capped": False} for name in ("captions", "translate-tr", "describe", "chapters")
        },
    }
    entries = cast(list[dict[str, Any]], root["tracks"])
    tracks = {t["namespace"]: t for t in entries}
    captions = tracks["talk/virus/agents/captions"]
    assert captions == {
        "name": "items",
        "namespace": "talk/virus/agents/captions",
        "packaging": "eventtimeline",
        "mimeType": "application/json",
        "eventType": "urn:msf:captions:webvtt",
        "role": "caption",
        "lang": "en",
        "label": "Captions (English)",
        "isLive": True,
        "template": [0, 4000, [0, 0], [1, 0], 1_790_812_800_000, 4000],
        "tt": {"dependsOn": [], "latenessMs": 3000, "cost": "free"},  # line 4, recorded at the end
    }
    translation = tracks["talk/virus/agents/translate-tr"]
    assert (translation["role"], translation["lang"]) == ("subtitle", "tr")
    assert translation["tt"] == {"dependsOn": ["talk/virus/agents/captions/items"], "latenessMs": 2500, "cost": "free"}
    slides = tracks["talk/virus/agents/describe"]
    assert (slides["eventType"], "role" in slides) == ("com.talktracks.slides", False)
    assert slides["tt"]["dependsOn"] == ["talk/virus/slides/frames"]
    assert slides["tt"]["latenessMs"] == 800
    outline = tracks["talk/virus/agents/chapters"]
    assert (outline["name"], outline["eventType"], "template" in outline) == (
        "outline",
        "com.talktracks.outline",
        False,
    )
    json.dumps(root)  # plain JSON throughout

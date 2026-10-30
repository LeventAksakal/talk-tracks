"""The speaker's and the room service's event tracks: archived per slice with their carry-ins, replayed by FETCH
(decision 0022), and a looped demo room's slides as deck and slide tracks."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any, Protocol, cast

import numpy as np
import pytest

from talk_tracks.archive.catalog import CatalogFeed
from talk_tracks.archive.events import (
    FINISH_IDLE_S,
    HistoryOut,
    MirroredTrack,
    RoomEvents,
    history_path,
)
from talk_tracks.archive.slices import NORMAL, Slice, SliceObject, TrackArchive
from talk_tracks.contracts import (
    SLICE_MS,
    Author,
    CurrentSlideObject,
    CurrentSlideRecord,
    DeckImage,
    DeckInfo,
    DeckObject,
    DeckRecord,
    InkBegin,
    InkEnd,
    InkObject,
    InkPoints,
    InkRecord,
    InkStroke,
    PointerAt,
    PointerObject,
    PointerOff,
    PointerRecord,
    RoomStateObject,
    ShowSlide,
    Wire,
)
from talk_tracks.contracts import RoomCatalog as MsfRoomCatalog
from talk_tracks.demo_slides import DECK_GROUP, LectureSlides, jpeg_size, with_slides
from talk_tracks.live_slices import Refused, Stats
from talk_tracks.records import current_slide, encode, ink_carry, last_record
from talk_tracks.room_catalog import RoomCatalog, speaker_sources
from talk_tracks.slideshow import Slide, jpeg

ROOM = "talk1"
NS = f"talk/{ROOM}/slides"
E = 1_761_650_000_000

class Timed(Protocol):
    @property
    def m(self) -> int: ...


# --- a fake relay: the speaker's objects in, FETCH sources out ------------------------------------------------


class FakeOut:
    """A published track: what went out live, and the FETCH source the room service registered."""

    def __init__(self) -> None:
        self.live: dict[int, list[bytes]] = {}
        self.ended: list[int] = []
        self.source: Callable[[int], Awaitable[Slice]] | None = None

    def subscribed(self) -> bool:
        return False

    async def put(self, group: int, object_id: int, payload: bytes) -> None:
        objects = self.live.setdefault(group, [])
        assert object_id == len(objects)
        objects.append(payload)

    async def end_group(self, group: int) -> None:
        self.ended.append(group)

    async def end_track(self) -> None:
        pass

    def serve(
        self,
        source: Callable[[int], Awaitable[Slice]],
        stats: Stats | None = None,
        open_slice: Callable[[], int | None] | None = None,
    ) -> None:
        self.source = source

    async def fetch(self, group: int) -> list[bytes]:
        """A FETCH of one group, as ``moq.SlicedOut.serve`` answers it: the normal objects, or REQUEST_ERROR."""
        assert self.source is not None
        found = await self.source(group)
        return [o.payload for o in found.objects if o.status == NORMAL]


class FakeRelay:
    def __init__(self, speaker: dict[str, list[tuple[int, int, bytes]]] | None = None) -> None:
        self.speaker = speaker or {}  # track -> (group, object, payload) as the speaker's console sent them
        self.published: dict[tuple[str, str], FakeOut] = {}
        self.drained = 0

    async def joined(self, namespace: str, track: str) -> AsyncIterator[tuple[int, int, bytes]]:
        assert namespace == NS
        for obj in self.speaker.get(track, []):
            yield obj
            await asyncio.sleep(0)
        self.drained += 1
        await asyncio.Event().wait()  # the subscription stays open until the speaker leaves

    async def publish_sliced(self, namespace: str, track: str) -> HistoryOut:
        out = self.published[(namespace, track)] = FakeOut()
        return out


async def until(check: Callable[[], bool]) -> None:
    for _ in range(1000):
        if check():
            return
        await asyncio.sleep(0)
    raise AssertionError("timed out")


# --- a recorded talk, as the speaker's console sends it ---------------------------------------------------------


def sliced[R: Timed](
    records: Sequence[R], first: int, last: int, carry: Callable[[list[R], int], Sequence[Wire]]
) -> list[tuple[int, int, bytes]]:
    """Groups ``first..last`` of a sliced track: object 0 the carry-in of every earlier record (given the slice's
    start), then one object per record."""
    out: list[tuple[int, int, bytes]] = []
    for k in range(first, last + 1):
        out.append((k, 0, encode(carry([r for r in records if r.m < k * SLICE_MS], k * SLICE_MS))))
        mine = [r for r in records if k * SLICE_MS <= r.m < (k + 1) * SLICE_MS]
        out += [(k, i + 1, encode([cast(Wire, r)])) for i, r in enumerate(mine)]
    return out


DECK = 3  # loaded in slice 3
SLIDES = [
    CurrentSlideRecord(m=12_500, data=ShowSlide(deck=DECK, index=0)),
    CurrentSlideRecord(m=21_000, data=ShowSlide(deck=DECK, index=1)),
    CurrentSlideRecord(m=26_000, data=ShowSlide(deck=DECK, index=0)),
]
STROKE = [(0.1, 0.1), (0.2, 0.2), (0.3, 0.25)]
SPEAKER = Author(id="u1", name="Ada", speaker=True)
PEN = InkBegin(
    stroke="s1", deck=DECK, index=0, tool="pen", color="#ff0000", width=0.004, points=[(0.1, 0.1)], by=SPEAKER
)
INK = [
    InkRecord(m=13_000, data=PEN),
    InkRecord(m=13_200, data=InkPoints(stroke="s1", points=[(0.2, 0.2), (0.3, 0.25)])),
    InkRecord(m=13_500, data=InkEnd(stroke="s1")),
    InkRecord(m=22_000, data=PEN.model_copy(update={"stroke": "s2", "index": 1, "points": [(0.5, 0.5)]})),
    InkRecord(m=22_400, data=InkEnd(stroke="s2")),
    # slide 0 shown again: its strokes re-sent with m = that moment, so one group is enough for a seek
    InkRecord(
        m=26_000,
        data=InkStroke.model_validate({**PEN.model_dump(), "kind": "stroke", "points": STROKE, "done": True}),
    ),
]
POINTER = [
    PointerRecord(m=14_000, data=PointerAt(x=0.4, y=0.4)),
    PointerRecord(m=14_050, data=PointerAt(x=0.42, y=0.41)),
    PointerRecord(m=17_100, data=PointerOff()),
    PointerRecord(m=27_000, data=PointerAt(x=0.9, y=0.1)),
]


def deck_objects() -> list[tuple[int, int, bytes]]:
    info = DeckRecord(m=12_000, data=DeckInfo(count=2, aspect=16 / 9, title="Talk"))
    images = [
        DeckRecord(m=12_000, data=DeckImage(index=i, mime="image/png", width=16, height=9, data_b64="iVBORw0KGgo="))
        for i in range(2)
    ]
    return [(DECK, i, encode([r])) for i, r in enumerate([info, *images])]


def talk() -> dict[str, list[tuple[int, int, bytes]]]:
    """Room time 12-32 s (slices 3-7) of a talk: the console's objects per track, in the order it sent them."""

    def on_screen(t: int) -> ShowSlide | None:
        return current_slide([s for s in SLIDES if s.m < t])

    return {
        "deck": deck_objects(),
        "slide": sliced(SLIDES, 3, 7, lambda before, _: last_record(before)),
        "ink": sliced(INK, 3, 7, lambda before, start: ink_carry(before, on_screen(start))),
        "pointer": sliced(POINTER, 3, 7, lambda before, _: last_record(before)),
    }


def up_to(payloads: list[bytes], model: type[Any], t: int) -> list[Any]:
    """What a player does with a fetched group: every record of its objects with m <= t."""
    return [r for p in payloads for r in model.model_validate_json(p).root if r.m <= t]


# --- the tests -------------------------------------------------------------------------------------------------


async def test_a_recorded_talks_slides_ink_and_pointer_replay_from_the_archive_by_fetch(tmp_path: Path) -> None:
    sent = talk()
    relay = FakeRelay(sent)
    events = RoomEvents(ROOM, relay, tmp_path)
    events.announced(NS, True)
    await until(lambda: relay.drained == 5)  # deck, slide, ink, marks, pointer: room_catalog's list
    events.announced(NS, False)  # the speaker leaves: every slice is final
    history = history_path(NS)
    assert history == f"talk/{ROOM}/archive/slides"
    outs = {track: relay.published[(history, track)] for track in ("deck", "slide", "ink", "pointer")}

    # byte for byte what the speaker sent, under its own group and object numbers
    for track, objects in sent.items():
        for group in sorted({k for k, _, _ in objects}):
            assert await outs[track].fetch(group) == [p for k, _, p in objects if k == group]
        assert (tmp_path / ROOM / "slides" / track / f"{objects[-1][0]:08d}.slice").exists()

    # a seek to t needs one group per track: the state on screen is the same as from every record
    for t in (12_600, 13_300, 16_000, 19_000, 21_500, 22_200, 25_000, 26_500, 27_100, 31_999):
        k = t // SLICE_MS
        slide = current_slide(up_to(await outs["slide"].fetch(k), CurrentSlideObject, t))
        assert slide == current_slide([s for s in SLIDES if s.m <= t]), t
        ink = ink_carry(up_to(await outs["ink"].fetch(k), InkObject, t), slide)
        expected = ink_carry([r for r in INK if r.m <= t], slide)
        assert ink == expected, t  # whole strokes, with the m they appeared at
        pointer = last_record(up_to(await outs["pointer"].fetch(k), PointerObject, t))
        assert pointer == last_record([p for p in POINTER if p.m <= t]), t
        assert slide is not None and slide.deck == DECK
    deck = [r.data for p in await outs["deck"].fetch(DECK) for r in DeckObject.model_validate_json(p).root]
    assert isinstance(deck[0], DeckInfo) and deck[0].count == 2

    with pytest.raises(Refused):  # never archived: a REQUEST_ERROR, not an empty group
        await outs["ink"].fetch(40)

    # the room service restarts: the talk stays fetchable, though the speaker never comes back
    relay2 = FakeRelay()
    again = RoomEvents(ROOM, relay2, tmp_path)
    await again.restore()
    assert await relay2.published[(history, "ink")].fetch(6) == await outs["ink"].fetch(6)
    assert {t.name for t in again.catalog_tracks()} == {"deck", "slide", "ink", "pointer"}  # marks: nothing sent


def test_a_mirrored_slice_is_kept_whole_or_not_at_all(tmp_path: Path) -> None:
    now = [0.0]
    archive = TrackArchive.of(NS, "pointer", root=tmp_path)
    assert archive.relpath == f"{ROOM}/slides/pointer"
    finished: list[Path] = []
    mirror = MirroredTrack(archive, sliced=True, on_file=finished.append, clock=lambda: now[0])
    assert not mirror.put(5, 2, b"[]")  # joined after object 0: not archived, nor its later objects
    assert not mirror.put(5, 3, b"[]")
    assert mirror.put(6, 0, b"[]") and mirror.put(6, 1, b'[{"m":24001,"data":{"kind":"off"}}]')
    assert not mirror.put(6, 1, b"[]")  # a resubscription repeats the group
    now[0] += FINISH_IDLE_S
    mirror.tick()  # quiet for longer than a slice: finished
    assert finished == [archive.path(6)]
    assert not mirror.put(6, 0, b"[]")  # final: never written again
    assert mirror.open_slice() == 7
    # a slice a stopped room service left open is written afresh from object 0
    archive.write(8, SliceObject(0, b"[old]"))
    archive.close()
    fresh = MirroredTrack(TrackArchive.of(NS, "pointer", root=tmp_path), sliced=True)
    assert fresh.put(8, 0, b"[]")
    fresh.finish_all()
    found = archive.read_local(8)
    assert found is not None and [o.payload for o in found.objects if o.status == NORMAL] == [b"[]"]


async def test_the_room_track_says_on_air_and_paused_and_is_fetched_from_the_archive(tmp_path: Path) -> None:
    relay = FakeRelay()
    events = RoomEvents(ROOM, relay, tmp_path)
    await events.tick(None, live=True)  # no epoch yet: nothing is stamped
    assert not relay.published
    await events.tick(9_000, live=True)
    await events.tick(10_500, live=True)
    await events.tick(13_000, live=True)  # a new slice opens with the carry-in
    await events.tick(14_200, live=False)  # the teacher broadcast is gone
    out = relay.published[(f"talk/{ROOM}/catalog", "room")]
    assert sorted(out.live) == [2, 3] and out.ended == [2, 3]

    def states(payloads: list[bytes]) -> list[tuple[int, str]]:
        return [(r.m, r.data.state) for p in payloads for r in RoomStateObject.model_validate_json(p).root]

    assert await out.fetch(2) == out.live[2]  # what went out live is what a FETCH gets
    assert states(await out.fetch(2)) == [(9_000, "on_air")]
    assert states(await out.fetch(3)) == [(9_000, "on_air"), (14_200, "paused")]  # the carry-in, then the change
    assert [t.name for t in events.catalog_tracks()] == ["room"]

    # restarted: seeded from the newest slice, it continues in the next one
    relay2 = FakeRelay()
    again = RoomEvents(ROOM, relay2, tmp_path)
    await again.tick(20_000, live=True)
    out2 = relay2.published[(f"talk/{ROOM}/catalog", "room")]
    assert states(out2.live[5]) == [(14_200, "paused"), (20_000, "on_air")]
    with pytest.raises(Refused):
        await out2.fetch(4)  # nobody on air then: no slice


async def test_the_live_rooms_catalog_lists_the_event_tracks_and_sources(tmp_path: Path) -> None:
    relay = FakeRelay({"slide": [(3, 0, b"[]")]})
    events = RoomEvents(ROOM, relay, tmp_path)
    events.announced(NS, True)
    await until(lambda: relay.drained == 5)
    await events.tick(12_000, live=True)
    cat = CatalogFeed(ROOM, tmp_path)
    cat.epoch_ms = E
    cat.event_tracks = events.catalog_tracks()
    cat.sources = speaker_sources(ROOM, audio=True, camera=True, slides=events.slides_on_air())
    doc = json.loads(cat.changed() or b"")
    MsfRoomCatalog.model_validate(doc)
    names = [(t["namespace"], t["name"]) for t in doc["tracks"]]
    assert names == [
        (NS, "deck"),
        (NS, "slide"),
        (NS, "ink"),
        (NS, "marks"),
        (NS, "pointer"),
        (f"talk/{ROOM}/catalog", "room"),
    ]
    assert [s["kind"] for s in doc["tt"]["sources"]] == ["audio", "camera", "slides"]
    await events.close()


# --- a looped demo room's slides -----------------------------------------------------------------------------


def picture(shade: int) -> bytes:
    rgb = np.full((90, 160, 3), shade, dtype=np.uint8)
    return jpeg(rgb)


def test_a_demo_rooms_slides_are_a_deck_and_a_sliced_slide_track() -> None:
    slides = [Slide(0, picture(10)), Slide(3_000, picture(120)), Slide(9_000, picture(240))]
    period = 12_000  # a 10 s lecture, rounded up to whole slices
    deck = LectureSlides.of(slides, period)

    objects = [r for p in deck.deck_group(DECK_GROUP) for r in DeckObject.model_validate_json(p.payload).root]
    info, *images = [r.data for r in objects]
    assert isinstance(info, DeckInfo) and info.count == 3 and info.aspect == pytest.approx(16 / 9, rel=0.01)
    for i, image in enumerate(images):
        assert isinstance(image, DeckImage) and image.index == i
        assert (image.width, image.height) == jpeg_size(base64.b64decode(image.data_b64)) == (160, 90)
    assert deck.deck_group(1) == ()

    def on_screen(t: int) -> int | None:
        group = [p.payload for p in deck.slide_group(t // SLICE_MS)]
        shown = current_slide(up_to(group, CurrentSlideObject, t))
        assert shown is None or shown.deck == DECK_GROUP
        return None if shown is None else shown.index

    # loop 0, then loop 1 (12-24 s): its first slice carries the previous loop's last slide in
    expected = {1_000: 0, 3_500: 1, 8_999: 1, 9_000: 2, 11_999: 2, 12_000: 0, 15_000: 1, 23_000: 2}
    assert {t: on_screen(t) for t in expected} == expected
    carry = CurrentSlideObject.model_validate_json(deck.slide_group(3)[0].payload).root  # 12-16 s
    assert [(r.m, r.data) for r in carry] == [(9_000, ShowSlide(deck=0, index=2))]
    assert deck.slide_group(3) == deck.slide_group(3)  # a pure function of the group: live and FETCH agree


def test_a_demo_rooms_catalog_carries_its_slide_tracks() -> None:
    built = with_slides(RoomCatalog(E, (), shift={183813200000000: 0}), "virus")
    doc = built.to_json()
    MsfRoomCatalog.model_validate(doc)
    tracks = cast(list[dict[str, Any]], doc["tracks"])
    names = [(t["namespace"], t["name"]) for t in tracks]
    assert names == [("talk/virus/slides", "deck"), ("talk/virus/slides", "slide")]
    assert "template" not in tracks[0] and tracks[1]["template"][1] == SLICE_MS
    tt = cast(dict[str, Any], doc["tt"])
    assert tt["sources"][-1] == {"kind": "slides", "namespace": "talk/virus/slides", "tracks": ["deck", "slide"]}

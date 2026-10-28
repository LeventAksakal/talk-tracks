"""A recording as sliced tracks (decision 0012): what a looping demo room publishes and serves by FETCH.

A recording holds each agent's full-state snapshots; the wire carries MSF event-timeline records, cut in 4 s slices
on the room clock (wiki/design/moq-track-system.md §4, ``contracts``). ``Template`` diffs each agent's snapshots once
into items on the lecture's own clock (file time), cuts them into slices by when they were published (the open slice
of the agent's input watermark, §4.2) and works out each slice's carry-in:

* captions: each new or changed final cue is an item, and so is each new interim text (``final: false`` under the
  next cue's id, its ``rev`` rising, replaced by the final cue later); the carry-in holds the last two final cues;
* translation: each new or changed translated cue, with its source cue's id and times;
* slides: each new or changed slide description; its carry-in is the slide on screen;
* chapters: the ``outline`` track instead, one group per revision whose single object holds every chapter, glossary
  term and the recap (terms and recap at the revision's time).

Each object is one ``CueObject``, ``SlideObject`` or ``OutlineObject``; a cue's id is its caption cue's id as a
decimal string.

``Room`` places loop k of the template on the room's clock: media time, ids and groups move by k periods, so a group
is a pure function of its number. The looper writes it live and answers a FETCH of it from the same function, and
both copies are byte-identical, as decision 0012 asks.
"""

from __future__ import annotations

import functools
import heapq
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from typing import Literal

from pydantic import Field

from .contracts import (
    CARRY_CUES,
    ITEMS_TRACK,
    OUTLINE_TRACK,
    SLICE_MS,
    AgentInfo,
    CaptionLine,
    CaptionsState,
    Chapter,
    ChapterData,
    CueObject,
    CueRecord,
    GlossaryTerm,
    OutlineObject,
    OutlineRecord,
    OutlineState,
    RecapData,
    SlideNote,
    SlideObject,
    SlideRecord,
    SlidesState,
    State,
    TermData,
    TrackStatus,
    TranslatedLine,
    TranslationState,
    Usage,
    Wire,
    agents_prefix,
    slice_of,
)
from .contracts import Cue as WebVttCue
from .contracts import Slide as WireSlide
from .recording import RecordedSnapshot
from .replay import Cue
from .room_catalog import CatalogTrack, RoomCatalog, depends_on
from .room_catalog import Kind as TrackKind

# --- one loop's bodies on the lecture clock; ``records`` turns them into the wire's objects ----------------------


class CaptionItem(Wire):
    type: Literal["caption"] = "caption"
    lang: str
    line: CaptionLine
    final: bool
    rev: int = Field(ge=0, default=0, description="Revision of this cue id: interim versions, then the final")


class TranslationItem(Wire):
    type: Literal["translation"] = "translation"
    lang: str
    line: TranslatedLine
    rev: int = Field(ge=0, default=0)


class CaptionsCarry(Wire):
    type: Literal["captions-carry"] = "captions-carry"
    lang: str
    lines: list[CaptionItem] = Field(max_length=CARRY_CUES, description="The last final cues before the slice")


class TranslationCarry(Wire):
    type: Literal["translation-carry"] = "translation-carry"
    lang: str
    lines: list[TranslationItem] = Field(max_length=CARRY_CUES)


class SlidesCarry(Wire):
    type: Literal["slides-carry"] = "slides-carry"
    lang: str
    slide: SlideNote | None


class SlideItem(Wire):
    type: Literal["slide"] = "slide"
    lang: str
    slide: SlideNote


class OutlineSnapshot(Wire):
    type: Literal["outline"] = "outline"
    lang: str
    chapters: list[Chapter]
    glossary: list[GlossaryTerm]
    recap: str = ""


Carry = CaptionsCarry | TranslationCarry | SlidesCarry
Item = CaptionItem | TranslationItem | SlideItem
WireObject = CueObject | SlideObject | OutlineObject


def _cue(line: CaptionLine | TranslatedLine, *, rev: int, final: bool) -> CueRecord:
    start = line.start_ms
    cue = WebVttCue(start=start, end=max(start, line.end_ms), id=str(line.id), text=line.text, rev=rev, final=final)
    return CueRecord(m=start, data=cue)


def _slide(note: SlideNote) -> SlideRecord:
    return SlideRecord(m=note.at_ms, data=WireSlide(id=note.id, at=note.at_ms, text=note.description))


def _chapter(c: Chapter) -> OutlineRecord:
    return OutlineRecord(m=c.start_ms, data=ChapterData(id=c.id, start=c.start_ms, title=c.title, summary=c.summary))


def records(body: Carry | Item | OutlineSnapshot, at_ms: int) -> WireObject:
    """The wire object of a body already on the room clock; ``at_ms`` is when it goes out (an outline's terms and
    recap carry it as their ``m``)."""
    if isinstance(body, CaptionItem):
        return CueObject([_cue(body.line, rev=body.rev, final=body.final)])
    if isinstance(body, TranslationItem):
        return CueObject([_cue(body.line, rev=body.rev, final=True)])
    if isinstance(body, CaptionsCarry | TranslationCarry):
        return CueObject([_cue(i.line, rev=i.rev, final=True) for i in body.lines])
    if isinstance(body, SlideItem):
        return SlideObject([_slide(body.slide)])
    if isinstance(body, SlidesCarry):
        return SlideObject([_slide(body.slide)] if body.slide else [])
    out = [_chapter(c) for c in body.chapters]
    out += [OutlineRecord(m=at_ms, data=TermData(term=t.term, definition=t.definition)) for t in body.glossary]
    if body.recap:
        out.append(OutlineRecord(m=at_ms, data=RecapData(text=body.recap)))
    return OutlineObject(out)


def encode(obj: WireObject) -> bytes:
    return obj.model_dump_json(by_alias=True).encode()


# --- the template: one loop's objects on the lecture clock ----------------------------------------------------------


@dataclass(frozen=True)
class Stamped:
    """One object's body at lecture time ``at_ms``, with the agent's cumulative usage then."""

    at_ms: int
    usage: Usage
    body: Carry | Item | OutlineSnapshot


@dataclass(frozen=True)
class SlicedAgent:
    """One agent's track for one loop: ``groups[j]`` is group j's objects, in object order. On an items track group
    j is slice j (object 0 its carry-in); on the outline track it is revision j."""

    info: AgentInfo
    track: str
    groups: tuple[tuple[Stamped, ...], ...]

    @property
    def body(self) -> Carry | Item | OutlineSnapshot:
        return self.groups[0][0].body

    @property
    def kind(self) -> TrackKind:
        body = self.body
        if isinstance(body, OutlineSnapshot):
            return "outline"
        if isinstance(body, CaptionsCarry):
            return "captions"
        return "translation" if isinstance(body, TranslationCarry) else "slides"

    def spend_usd(self) -> float:
        """What generating the track cost: the recording's cumulative usage at its end."""
        return _spend(self.groups)

    def lateness_ms(self) -> int:
        """``L``: how long after its own time an item was published at most, rounded up to 100 ms. An outline
        revision stands alone in its group, so the outline has none."""
        late = [s.at_ms - t for g in self.groups for s in g if (t := item_ms(s.body)) is not None]
        return -(-max(0, *late) // 100) * 100 if late else 0


def _spend(groups: Sequence[Sequence[Stamped]]) -> float:
    return max((s.usage.cost_usd for g in groups for s in g), default=0.0)


def item_ms(body: Carry | Item | OutlineSnapshot) -> int | None:
    """An item's own time (a cue's start, a slide's appearance); None for a carry-in or an outline."""
    if isinstance(body, CaptionItem | TranslationItem):
        return body.line.start_ms
    return body.slide.at_ms if isinstance(body, SlideItem) else None


def period_of(duration_ms: int) -> int:
    """A loop's length on the room clock: the lecture, rounded up to whole slices, so every loop starts a slice."""
    return max(1, -(-duration_ms // SLICE_MS)) * SLICE_MS


def caption_items(snapshots: Iterable[RecordedSnapshot], at: Lecture) -> Iterator[Stamped]:
    seen: dict[int, CaptionLine] = {}
    revs: dict[int, int] = {}  # the last revision sent of each cue id
    interim = ""

    def rev(i: int) -> int:
        revs[i] = revs.get(i, -1) + 1
        return revs[i]

    for snap in snapshots:
        state = snap.state
        assert isinstance(state, CaptionsState)
        t = at.time(snap.media_ms)
        for line in state.lines:
            line = at.line(line)
            if seen.get(line.id) != line:
                seen[line.id] = line
                yield Stamped(t, snap.usage, CaptionItem(lang=state.lang, line=line, final=True, rev=rev(line.id)))
        if state.interim != interim:
            interim = state.interim
            if interim:
                last = seen[max(seen)] if seen else None
                start = last.end_ms if last else 0
                line = CaptionLine(
                    id=last.id + 1 if last else 0,
                    start_ms=start,
                    end_ms=max(start, at.media(snap.media_ms)),
                    text=interim,
                )
                yield Stamped(t, snap.usage, CaptionItem(lang=state.lang, line=line, final=False, rev=rev(line.id)))


def translation_items(
    snapshots: Iterable[RecordedSnapshot], at: Lecture, sources: dict[int, CaptionLine]
) -> Iterator[Stamped]:
    seen: dict[int, TranslatedLine] = {}
    revs: dict[int, int] = {}
    for snap in snapshots:
        state = snap.state
        assert isinstance(state, TranslationState)
        for line in state.lines:
            source = sources.get(line.id)
            wire = TranslatedLine(
                id=line.id,
                start_ms=source.start_ms if source else 0,
                end_ms=source.end_ms if source else 0,
                text=line.text,
            )
            if seen.get(line.id) != wire:
                seen[line.id] = wire
                revs[line.id] = revs.get(line.id, -1) + 1
                item = TranslationItem(lang=state.lang, line=wire, rev=revs[line.id])
                yield Stamped(at.time(snap.media_ms), snap.usage, item)


def slide_items(snapshots: Iterable[RecordedSnapshot], at: Lecture) -> Iterator[Stamped]:
    seen: dict[int, SlideNote] = {}
    for snap in snapshots:
        state = snap.state
        assert isinstance(state, SlidesState)
        for note in state.slides:
            note = note.model_copy(update={"at_ms": at.media(note.at_ms)})
            if seen.get(note.id) != note:
                seen[note.id] = note
                yield Stamped(at.time(snap.media_ms), snap.usage, SlideItem(lang=state.lang, slide=note))


def outline_revisions(snapshots: Iterable[RecordedSnapshot], at: Lecture) -> Iterator[Stamped]:
    last: OutlineSnapshot | None = None
    for snap in snapshots:
        state = snap.state
        assert isinstance(state, OutlineState)
        chapters = [c.model_copy(update={"start_ms": at.media(c.start_ms)}) for c in state.chapters]
        body = OutlineSnapshot(lang=state.lang, chapters=chapters, glossary=state.glossary, recap=state.recap)
        if body != last:
            last = body
            yield Stamped(at.time(snap.media_ms), snap.usage, body)


@dataclass(frozen=True)
class Lecture:
    """Moves recording media times onto the lecture clock: ``origin_ms`` is the recording time of lecture time 0."""

    duration_ms: int
    origin_ms: int = 0

    def time(self, media_ms: int) -> int:
        """When a snapshot plays: those before the lecture at 0, those after it at its end."""
        return min(self.media(media_ms), self.duration_ms)

    def media(self, media_ms: int) -> int:
        return max(media_ms - self.origin_ms, 0)

    def line(self, line: CaptionLine) -> CaptionLine:
        if self.origin_ms == 0:
            return line
        return line.model_copy(update={"start_ms": self.media(line.start_ms), "end_ms": self.media(line.end_ms)})


def _carry(prior: Sequence[Item], empty: Carry) -> Carry:
    """The carry-in after ``prior`` items: the last lines, or the slide on screen."""
    if isinstance(empty, CaptionsCarry):
        finals = {item.line.id: item for item in prior if isinstance(item, CaptionItem) and item.final}
        return empty.model_copy(update={"lines": [finals[i] for i in sorted(finals)[-CARRY_CUES:]]})
    if isinstance(empty, TranslationCarry):
        lines = {item.line.id: item for item in prior if isinstance(item, TranslationItem)}
        return empty.model_copy(update={"lines": [lines[i] for i in sorted(lines)[-CARRY_CUES:]]})
    slides = [item.slide for item in prior if isinstance(item, SlideItem)]
    return empty.model_copy(update={"slide": slides[-1] if slides else None})


def slice_items(items: Sequence[Stamped], period_ms: int, empty: Carry) -> tuple[tuple[Stamped, ...], ...]:
    """Cut one loop's items (in publication order) into its slices, each opened by its carry-in."""
    groups: list[list[Stamped]] = []
    prior: list[Item] = []
    usage = Usage()
    n = 0
    for j in range(period_ms // SLICE_MS):
        start = j * SLICE_MS
        groups.append([Stamped(start, usage, _carry(prior, empty))])
        while n < len(items) and items[n].at_ms < start + SLICE_MS:
            body = items[n].body
            assert isinstance(body, CaptionItem | TranslationItem | SlideItem)
            groups[-1].append(items[n])
            prior.append(body)
            usage = items[n].usage
            n += 1
    return tuple(tuple(g) for g in groups)


@dataclass(frozen=True)
class Template:
    """One loop of a recording as sliced tracks, on the lecture clock (file time 0 to the period)."""

    duration_ms: int
    period_ms: int
    stride: int  # one more than the largest id anywhere: loop k moves ids by k * stride
    agents: tuple[SlicedAgent, ...]

    @classmethod
    def build(
        cls, recorded: Sequence[tuple[AgentInfo, Sequence[RecordedSnapshot]]], duration_ms: int, *, origin_ms: int = 0
    ) -> Template:
        if duration_ms <= 0:
            raise ValueError("the lecture must have a positive duration")
        period = period_of(duration_ms)
        at = Lecture(duration_ms, origin_ms)
        last = period - 1  # an item stamped at the very end still belongs to the last slice

        def stamped(items: Iterable[Stamped]) -> list[Stamped]:
            return [s if s.at_ms <= last else Stamped(last, s.usage, s.body) for s in items]

        sources: dict[int, CaptionLine] = {}
        for _, snapshots in recorded:
            for snap in snapshots:
                if isinstance(snap.state, CaptionsState):
                    for line in snap.state.lines:
                        sources[line.id] = at.line(line)
        agents: list[SlicedAgent] = []
        for info, snapshots in recorded:
            if not snapshots:
                continue
            first: State = snapshots[0].state
            lang = first.lang
            if isinstance(first, OutlineState):
                revisions = stamped(outline_revisions(snapshots, at))
                agents.append(SlicedAgent(info, OUTLINE_TRACK, tuple((r,) for r in revisions)))
                continue
            if isinstance(first, CaptionsState):
                items, empty = stamped(caption_items(snapshots, at)), CaptionsCarry(lang=lang, lines=[])
            elif isinstance(first, TranslationState):
                items = stamped(translation_items(snapshots, at, sources))
                empty = TranslationCarry(lang=lang, lines=[])
            else:
                items, empty = stamped(slide_items(snapshots, at)), SlidesCarry(lang=lang, slide=None)
            agents.append(SlicedAgent(info, ITEMS_TRACK, slice_items(items, period, empty)))
        ids = [i for agent in agents for group in agent.groups for s in group for i in body_ids(s.body)]
        return cls(duration_ms, period, max(ids, default=-1) + 1, tuple(agents))


def room_catalog(template: Template, room: str, epoch_ms: int, clock_wall: int, now_ms: int) -> RoomCatalog:
    """The room catalog of a looped recording: its tracks free and live, each agent's spend what generating it cost
    once, its teacher broadcast (``clock_wall``) unshifted."""
    agents = [(f"{agents_prefix(room)}/{a.info.name}", a) for a in template.agents]
    captions = [f"{ns}/{a.track}" for ns, a in agents if a.kind == "captions"]
    tracks = tuple(
        CatalogTrack(
            namespace=ns,
            name=a.track,
            kind=a.kind,
            lang=a.body.lang,
            label=a.info.label,
            lateness_ms=a.lateness_ms(),
            cost="free",
            depends_on=depends_on(room, a.kind, captions),
        )
        for ns, a in agents
    )
    spend = {a.info.name: round(a.spend_usd(), 6) for _, a in agents}
    status = {
        name: TrackStatus(
            status="live", producing=True, fetches_served=0, backfills=0, spend_usd=usd, updated_ms=now_ms
        )
        for name, usd in spend.items()
    }
    return RoomCatalog(epoch_ms, tracks, shift={clock_wall: 0}, status=status)


def body_ids(body: Carry | Item | OutlineSnapshot) -> list[int]:
    if isinstance(body, CaptionItem | TranslationItem):
        return [body.line.id]
    if isinstance(body, CaptionsCarry | TranslationCarry):
        return [item.line.id for item in body.lines]
    if isinstance(body, SlideItem):
        return [body.slide.id]
    if isinstance(body, SlidesCarry):
        return [body.slide.id] if body.slide else []
    return [c.id for c in body.chapters]


def shift_body[B: Carry | Item | OutlineSnapshot](body: B, *, media_ms: int, ids: int) -> B:
    """The same body with every media time moved by ``media_ms`` and every id by ``ids``."""
    if media_ms == 0 and ids == 0:
        return body

    def line[L: CaptionLine | TranslatedLine](x: L) -> L:
        return x.model_copy(update={"id": x.id + ids, "start_ms": x.start_ms + media_ms, "end_ms": x.end_ms + media_ms})

    def note(s: SlideNote) -> SlideNote:
        return s.model_copy(update={"id": s.id + ids, "at_ms": s.at_ms + media_ms})

    if isinstance(body, CaptionItem | TranslationItem):
        return body.model_copy(update={"line": line(body.line)})
    if isinstance(body, CaptionsCarry | TranslationCarry):
        return body.model_copy(update={"lines": [x.model_copy(update={"line": line(x.line)}) for x in body.lines]})
    if isinstance(body, SlideItem):
        return body.model_copy(update={"slide": note(body.slide)})
    if isinstance(body, SlidesCarry):
        return body.model_copy(update={"slide": note(body.slide) if body.slide else None})
    chapters = [c.model_copy(update={"id": c.id + ids, "start_ms": c.start_ms + media_ms}) for c in body.chapters]
    return body.model_copy(update={"chapters": chapters})


# --- the room: loop after loop on the room clock ----------------------------------------------------------------


@dataclass(frozen=True)
class Placed:
    """An object of the room: its media time on the room clock and its payload."""

    media_ms: int
    payload: bytes


class Room:
    """The template looped on the room clock: loop k covers media time [k·period, (k+1)·period), and wall-clock time
    is ``epoch_ms`` plus media time. Group g of a track is loop ``g // per_loop``, group ``g % per_loop`` of the
    template; on an items track that makes g the slice of its media time."""

    def __init__(self, template: Template, epoch_ms: int) -> None:
        self.template = template
        self.epoch_ms = epoch_ms
        self.agents = {agent.info.name: agent for agent in template.agents}

    def per_loop(self, agent: str) -> int:
        return len(self.agents[agent].groups)

    def locate(self, agent: str, group: int) -> tuple[int, int] | None:
        """(loop, group in the template) of a room group, None for one the track never has."""
        per = self.per_loop(agent)
        if per == 0 or group < 0:
            return None
        return divmod(group, per)

    @functools.lru_cache(maxsize=256)  # noqa: B019 - one Room per process, the cache is meant to live with it
    def group(self, agent: str, group: int) -> tuple[Placed, ...]:
        """Every object of a room group, in object order."""
        where = self.locate(agent, group)
        if where is None:
            return ()
        loop, j = where
        track = self.agents[agent]
        media = loop * self.template.period_ms
        ids = loop * self.template.stride
        out: list[Placed] = []
        for s in track.groups[j]:
            at = media + s.at_ms
            out.append(Placed(at, encode(records(shift_body(s.body, media_ms=media, ids=ids), at))))
        return tuple(out)

    def published(self, agent: str, group: int, now_ms: int) -> tuple[Placed, ...]:
        """The objects of a group that are out by room media time ``now_ms``."""
        return tuple(p for p in self.group(agent, group) if p.media_ms <= now_ms)

    def current(self, agent: str, now_ms: int) -> int | None:
        """The group open at ``now_ms`` (the newest one out), None before the first."""
        track = self.agents[agent]
        if track.track == ITEMS_TRACK:
            return slice_of(now_ms) if track.groups else None
        loop, at = divmod(now_ms, self.template.period_ms)
        for r in range(len(track.groups) - 1, -1, -1):
            if track.groups[r][0].at_ms <= at:
                return loop * len(track.groups) + r
        return loop * len(track.groups) - 1 if loop > 0 and track.groups else None


def cues(template: Template, loop: int) -> Iterator[Cue]:
    """Every object of loop ``loop``, in lecture-time order (object order within a group; stable across agents)."""

    def agent_cues(order: int, agent: SlicedAgent) -> Iterator[tuple[int, int, int, Cue]]:
        per = len(agent.groups)
        n = 0
        for j, group in enumerate(agent.groups):
            for i, s in enumerate(group):
                yield s.at_ms, order, n, Cue(s.at_ms, agent.info.name, loop * per + j, i)
                n += 1

    streams = [agent_cues(order, agent) for order, agent in enumerate(template.agents)]
    for *_, cue in heapq.merge(*streams, key=lambda item: item[:3]):
        yield cue

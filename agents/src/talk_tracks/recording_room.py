"""A demo lecture's recording room, ``<id>-recording`` (decision 0032), built once into the archive. Transport-free.

``record-archive`` turns a recording (``data/demo/<id>/``: the lecture and its agents' snapshots) into an ended
room of the archive, in the layout the room service writes for a real talk (wiki/howto/archive.md), so the paths
that replay a past talk replay it: the speaker's media as fMP4 runs with HLS playlists, ``room.json`` and its entry in
``rooms.json`` (written by ``archive.store``, as the room service would), every AI track's slices with its
``track.json`` (labelled recorded, free, idle), and the ``room`` track's slices (``on_air`` at 00:00, ``ended`` at the
end). The AI tracks are the recording's at the delay each agent really had (``session.honest_recording``).

No slide is written to disk (ticket 0001): ``serve-recording`` finds them in the lecture and keeps them in memory.
The lecture's ``regions.json`` (``find-regions``: where the slides and the webcam sit in its frame, numbers only) is
copied into the room's folder, so ``serve-recording`` has it without the lecture.

Room time 0 is the lecture's 00:00 and ``E`` the slice boundary at or before the recording's start: the room's
playlists date it when the recording was made.
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass
from pathlib import Path

from .archive.slices import SliceObject, TrackArchive, TrackInfo
from .archive.store import Archive
from .contracts import ROOM_TRACK, SLICE_MS, RoomState, RoomStateRecord, catalog_path, slice_of
from .lecture import AUDIO_TRACK, VIDEO_TRACK, catalog, legacy_frame, packets, probe
from .recording import load_manifest
from .regions import FILE as REGIONS_FILE
from .regions import beside, load
from .session import RoomStates, honest_recording, tail_ms
from .slicing import Room, Template, recorded_label

log = logging.getLogger("talk_tracks.recording_room")

LECTURE_FILE = "lecture.mp4"


@dataclass(frozen=True)
class Built:
    """What ``record_archive`` wrote."""

    room: str
    epoch_ms: int
    end_ms: int  # room time of the room's end (the lecture, plus the recorded tail)
    tracks: dict[str, int]  # "<agent>/<track>" -> slices written
    room_slices: int


def record_archive(recording: Path, room: str, root: Path, *, media: Path | None = None) -> Built:
    """Build the recording room ``room`` under the archive ``root`` from ``recording``. Refuses a room the archive
    already has: a recording room is written once (remove its folder and its ``rooms.json`` entry to build it again).
    Run it while the room service is stopped: it rewrites ``rooms.json`` from what it read at its start."""
    if (root / room).exists():
        raise FileExistsError(f"{root / room} exists: the recording room is built once")
    manifest = load_manifest(recording)
    lecture = media or recording / (manifest.media or LECTURE_FILE)
    info = probe(lecture)
    epoch = manifest.started_wall_ms // SLICE_MS * SLICE_MS
    origin = manifest.room_origin_ms or 0
    recorded = honest_recording(recording)
    end_ms = info.duration_ms + tail_ms(recorded, origin, info.duration_ms)
    template = Template.build(recorded, end_ms, origin_ms=origin)

    # The speaker's media first: the room's runs and its E. Agent slices already on disk would shift the broadcast.
    archive = Archive(root)
    archived = archive.room(room)
    raw = json.dumps(catalog(info, wall_ms=epoch), separators=(",", ":")).encode()
    if not archived.catalog(raw, epoch):
        raise ValueError("the lecture's catalog has no clock")
    names = {"audio": AUDIO_TRACK, "video": VIDEO_TRACK}
    last_ms = 0
    for packet in packets(lecture):
        wall = epoch + packet.file_us // 1000
        archived.media(names[packet.kind], legacy_frame(packet.file_us, packet.data), wall)
        last_ms = max(last_ms, packet.file_us // 1000)
    archived.teacher_gone()
    archive.close()
    if archived.epoch_ms != epoch:
        raise ValueError(f"the archive put E at {archived.epoch_ms}, not {epoch}")
    if load(beside(lecture)) is not None:  # read first: a broken file fails here, not in serve-recording
        shutil.copyfile(beside(lecture), root / room / REGIONS_FILE)

    # The AI tracks, at the delays their agents had, each labelled recorded.
    sliced = Room(template, epoch)
    captions = [f"{a.info.name}/{a.track}" for a in template.agents if a.kind == "captions"]
    written: dict[str, int] = {}
    for agent in template.agents:
        depends = captions if agent.kind in ("translation", "outline") else []
        if agent.kind == "slides":
            depends = [f"talk/{room}/slides/frames"]
        track = TrackArchive(
            room,
            agent.info.name,
            agent.track,
            root=root,
            info=TrackInfo(
                kind=agent.kind,
                label=recorded_label(agent.info.label),
                lang=agent.body.lang,
                depends=depends,
                cost="free",
                lateness_ms=agent.lateness_ms(),
            ),
        )
        n = sliced.group_count(agent.info.name)
        for k in range(n):
            objects = [SliceObject(i, p.payload) for i, p in enumerate(sliced.group(agent.info.name, k))]
            track.create(k, objects, end_of_track=k == n - 1)
        track.report("idle", spend_usd=agent.spend_usd())
        track.close()
        written[f"{agent.info.name}/{agent.track}"] = n

    # The room track: on air at 00:00, ended at the room's end, a slice every 4 s, each opened by its carry-in.
    end = max(end_ms, last_ms)
    states = RoomStates([RoomStateRecord(m=0, data=RoomState(state="on_air"))])
    states.add(RoomStateRecord(m=end, data=RoomState(state="ended")))
    room_track = TrackArchive.of(catalog_path(room), ROOM_TRACK, root=root)
    count = slice_of(end) + 1
    for k in range(count):
        objects = [SliceObject(i, payload) for i, payload in enumerate(states.group(k, end))]
        room_track.create(k, objects, end_of_track=k == count - 1)
    built = Built(room, epoch, end, written, count)
    log.info(
        "recording room %s: E %d, %.1f s, %s; the room track in %d slices",
        room,
        epoch,
        end / 1000,
        ", ".join(f"{t} ({n} slices)" for t, n in written.items()) or "no AI tracks",
        count,
    )
    return built

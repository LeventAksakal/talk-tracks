from talk_tracks.contracts import ENVELOPE, AgentInfo, Envelope, Usage
from talk_tracks.cores.captions import CaptionsCore
from talk_tracks.follow import NewestInstance, SnapshotFilter


def envelope(instance: str, seq: int) -> bytes:
    return ENVELOPE.dump_json(
        Envelope(
            agent=AgentInfo(name="captions", label="Captions", model="fake"),
            instance=instance,
            seq=seq,
            at_ms=1,
            usage=Usage(),
            state=CaptionsCore("en").state(),
        )
    )


def test_follows_the_newest_numeric_instance_only() -> None:
    newest = NewestInstance()
    assert newest.offer("1000")
    assert not newest.offer("900")  # a lingering older broadcast
    assert not newest.offer("not-a-number")
    assert newest.offer("2000")  # the replacement
    assert newest.current == "2000"


def test_snapshots_pass_once_in_order_and_only_from_the_followed_instance() -> None:
    f = SnapshotFilter()
    seen = [
        f.accept(envelope("1000", 1), "1000"),
        f.accept(envelope("1000", 1), "1000"),  # heartbeat
        f.accept(envelope("1000", 2), "1000"),
        f.accept(envelope("900", 7), "1000"),  # not followed
        f.accept(envelope("2000", 1), "2000"),  # replacement starts its own sequence
    ]
    assert [(e.instance, e.seq) if e else None for e in seen] == [("1000", 1), None, ("1000", 2), None, ("2000", 1)]

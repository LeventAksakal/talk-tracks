"""Following another agent: which instance to read, and which of its snapshots are new. Transport-free.

Every agent process publishes under a fresh namespace named by its start time in ms
(``talk/<room>/agents/<agent>/<instance>``). A replacement therefore always has a larger instance number than the one
it replaces, and a killed process's broadcast can linger on the relay for seconds after it died: following the
newest numeric instance and ignoring the rest handles both.
"""

from __future__ import annotations

from .contracts import ENVELOPE, Envelope


def instance_number(instance: str) -> int | None:
    return int(instance) if instance.isdigit() else None


class NewestInstance:
    """The instance to follow: the largest numeric instance name announced so far."""

    def __init__(self) -> None:
        self.current: str | None = None

    def offer(self, instance: str) -> bool:
        """An instance was announced. True when it is newer than the one followed, which it then replaces."""
        number = instance_number(instance)
        if number is None:
            return False
        if self.current is not None and number <= int(self.current):
            return False
        self.current = instance
        return True


class SnapshotFilter:
    """Lets through each snapshot of the followed instance once, in order. Heartbeats repeat a seq; skip them."""

    def __init__(self) -> None:
        self._instance: str | None = None
        self._seq = -1

    def accept(self, payload: bytes, followed: str | None) -> Envelope | None:
        envelope = ENVELOPE.validate_json(payload)
        if envelope.instance != followed:
            return None
        if envelope.instance != self._instance:
            self._instance, self._seq = envelope.instance, -1
        if envelope.seq <= self._seq:
            return None
        self._seq = envelope.seq
        return envelope

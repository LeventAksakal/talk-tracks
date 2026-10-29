"""Captions core: ASR events in, subtitle-sized cues out. Plain Python, no network, no model.

A recogniser turn can run for minutes (the real-agent run had a median of 28-38 s, up to 139 s), so the core cuts
each turn into cues of subtitle size: at most ``MAX_CUE_MS`` and ``MAX_LINES`` lines of ``LINE_CHARS``, split at a
sentence end where there is one, else at a clause boundary, else at a word. Muse Voice gives no word timings, only
the turn's start and end, so times come from the character position: while the turn runs, the time the transcript
first reached that length; at the turn's end, interpolated between the last cut and the end.

A cue is published as an interim (``final`` false, ``rev`` rising) while its words come in, and once as final
when it is cut, with the same id. Ids are the cue's start in room ms (one more than the previous id when that is
taken), as strings: they rise with time and survive restarts.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence

from talk_tracks.asr.base import AsrEvent, AsrFinal, AsrPartial
from talk_tracks.contracts import CARRY_CUES, Cue
from talk_tracks.records import cue_number

LINE_CHARS = 42
MAX_LINES = 2
MAX_CUE_MS = 7_000
MIN_CUE_CHARS = 16  # a sentence end closer to the cue's start than this does not cut it
SENTENCE_END = (".", "?", "!", "\N{HORIZONTAL ELLIPSIS}")
CLAUSE_END = (",", ";", ":", "\N{EM DASH}", "\N{EN DASH}")


def fits(words: Sequence[str]) -> bool:
    """Whether the words wrap into at most MAX_LINES lines of LINE_CHARS (a longer word gets a line of its own)."""
    lines, width = 1, -1
    for word in words:
        if width >= 0 and width + 1 + len(word) > LINE_CHARS:
            lines, width = lines + 1, len(word)
        else:
            width += 1 + len(word)
    return lines <= MAX_LINES


def chars(words: Sequence[str]) -> int:
    return len(" ".join(words))


def choose_cut(words: Sequence[str], complete: int, duration: Callable[[int], int], *, whole: bool) -> int | None:
    """How many of ``words`` (the first ``complete`` of them heard in full) end the next cue, or None to wait.

    ``duration(i)`` is how long the first i words take. ``whole``: the words are all there is (the turn ended).
    """
    sentence = clause = fit = None
    for i in range(1, complete + 1):
        if not fits(words[:i]) or (i > 1 and duration(i) > MAX_CUE_MS):
            break
        fit = i
        last, size = words[i - 1], chars(words[:i])
        if last.endswith(SENTENCE_END) and size >= MIN_CUE_CHARS and sentence is None:
            sentence = i  # the first sentence end: the cue goes final as soon as the next word is heard
        elif last.endswith(CLAUSE_END) and size >= MIN_CUE_CHARS:
            clause = i
    if sentence is not None and sentence < len(words):
        return sentence
    too_long = not fits(words) or duration(len(words)) > MAX_CUE_MS
    if too_long:
        return clause or fit  # None while not even one word is heard in full
    return len(words) if whole else None


class CaptionsCore:
    def __init__(self, lang: str, cues: Sequence[Cue] = ()) -> None:
        """``cues`` are a predecessor's (its newest slice), so a restarted agent carries on after them."""
        self._lang = lang
        finals = sorted((c for c in cues if c.final), key=cue_number)
        self._finals: list[Cue] = finals[-CARRY_CUES:]
        self._last_id = max((cue_number(c) for c in cues), default=-1)
        self._last_end = max((c.end for c in cues), default=0)
        self._interim: Cue | None = None
        self._turn = False
        self._cut = 0  # words of this turn already in final cues
        self._cue_start = 0
        self._heard: list[tuple[int, int]] = []  # (transcript length, room ms when it was first that long)

    @property
    def lang(self) -> str:
        return self._lang

    def carry(self) -> list[Cue]:
        """The last final cues: what a viewer who joins at a slice start sees on screen."""
        return list(self._finals)

    def on_event(self, event: AsrEvent, now_ms: int) -> list[Cue]:
        """Apply one event heard by room ``now_ms``; return the cues to publish, in order."""
        if isinstance(event, AsrPartial):
            return self._partial(event, now_ms)
        return self._final(event)

    def _begin(self, start_ms: int) -> None:
        if not self._turn:
            self._turn, self._cut, self._heard = True, 0, []
            self._cue_start = max(start_ms, self._last_end)

    def _partial(self, event: AsrPartial, now_ms: int) -> list[Cue]:
        self._begin(now_ms if event.start_ms is None else event.start_ms)
        words = event.text.split()
        if not self._heard or chars(words) > self._heard[-1][0]:
            self._heard.append((chars(words), now_ms))
        out: list[Cue] = []
        while True:
            pending = words[self._cut :]
            base = chars(words[: self._cut]) + (1 if self._cut else 0)

            def heard_at(i: int, pending: list[str] = pending, base: int = base) -> int:
                if i >= len(pending):
                    return now_ms
                size = base + chars(pending[:i])
                return next((t for n, t in self._heard if n >= size), now_ms)

            i = choose_cut(pending, len(pending) - 1, lambda i: heard_at(i) - self._cue_start, whole=False)
            if i is None:
                break
            out.append(self._cut_cue(pending[:i], max(self._cue_start, heard_at(i))))
        rest = " ".join(words[self._cut :])
        if rest and (self._interim is None or rest != self._interim.text):
            out.append(self._interim_cue(rest, now_ms))
        return out

    def _final(self, event: AsrFinal) -> list[Cue]:
        if not self._turn or self._cut == 0:
            self._turn = False
            self._begin(event.start_ms)
        words = event.text.split()[self._cut :]
        end = max(event.end_ms, self._cue_start)
        out: list[Cue] = []
        start, total = self._cue_start, max(1, chars(words))
        while words:

            def at(i: int, words: list[str] = words) -> int:
                done = total - chars(words) + chars(words[:i])
                return start + (end - start) * done // total

            i = choose_cut(words, len(words), lambda i: at(i) - self._cue_start, whole=True) or len(words)
            out.append(self._cut_cue(words[:i], at(i)))
            words = words[i:]
        if self._interim is not None:  # the turn's end took back words heard as an interim: keep what was heard
            out.append(self._cut_cue(self._interim.text.split(), max(self._interim.end, self._cue_start)))
        self._turn = False
        return out

    def _next_id(self, start: int) -> str:
        self._last_id = max(start, self._last_id + 1)
        return str(self._last_id)

    def _interim_cue(self, text: str, now_ms: int) -> Cue:
        prev = self._interim
        cue = Cue(
            start=self._cue_start,
            end=max(self._cue_start, now_ms),
            id=prev.id if prev else self._next_id(self._cue_start),
            text=text,
            rev=prev.rev + 1 if prev else 0,
            final=False,
        )
        self._interim = cue
        return cue

    def _cut_cue(self, words: Sequence[str], end: int) -> Cue:
        prev, self._interim = self._interim, None
        cue = Cue(
            start=self._cue_start,
            end=max(end, self._cue_start),
            id=prev.id if prev else self._next_id(self._cue_start),
            text=" ".join(words),
            rev=prev.rev + 1 if prev else 0,
            final=True,
        )
        self._cut += len(words)
        self._cue_start = self._last_end = cue.end
        self._finals = [*self._finals, cue][-CARRY_CUES:]
        return cue

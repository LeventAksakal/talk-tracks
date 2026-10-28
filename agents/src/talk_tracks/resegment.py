"""Subtitle-sized cues from a recording whose caption lines are long ASR segments (half a minute is common).

Transport-free; the looper's converter runs it on a recording before slicing it (``slicing.Template``).

* **Where a line breaks.** Each final line becomes cues of at most ``MAX_CUE_MS`` and ``MAX_CUE_CHARS`` (two lines of
  42 characters): broken after a sentence end if one fits, else after a clause mark (, ; : dash) or before a
  conjunction, else at the last word that fits.
* **When each word was said.** No word timings are recorded, but the interim snapshots are: each says how many words
  of the line had been heard at its media time. The line's [start_ms, end_ms] is spread over its words in that
  shape, or by character position when the interims cover too little of the line.
* **When a cue goes out.** A cue is final from the snapshot whose interim had heard all of its words (the line's
  last cue when the line was final), so the room shows short final cues while the speaker is still talking; the
  interim then holds the rest of the line heard so far.
* **Translations.** A translated line is split over its source line's cues: sentence by sentence when both have the
  same number of sentences, else over the whole line, by character share. Turkish puts the verb last, so a cue's
  translation can be a clause off inside a sentence.

Cue ids count from 0 in the recording's line order; translated lines take their cue's id, so ``slicing`` gives them
the cue's times.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .contracts import AgentInfo, CaptionLine, CaptionsState, TranslatedLine, TranslationState
from .recording import RecordedSnapshot

MAX_CUE_MS = 7000
MAX_CUE_CHARS = 84  # two subtitle lines of 42
MIN_BREAK_CHARS = 24  # a sentence or clause break shorter than this waits for a later one
MIN_INTERIM_SHARE = 0.8  # interims that heard less of the line than this time it by character position instead

_QUOTES = "\"'" + "".join(map(chr, (0x2018, 0x2019, 0x201C, 0x201D)))  # straight and curly quotes
_DASHES = chr(0x2013) + chr(0x2014)  # en and em dash
_STRONG = re.compile(f"[.?!…][{_QUOTES})\\]]*$")
_MEDIUM = re.compile(f"[,;:{_DASHES}][{_QUOTES})\\]]*$|^[-{_DASHES}]$")
_CONJUNCTIONS = frozenset(
    {"and", "but", "or", "so", "because", "which", "that", "when", "while", "where", "whereas", "if", "then"}
    | {"although", "though", "unless", "until"}
)

Recorded = Sequence[tuple[AgentInfo, Sequence[RecordedSnapshot]]]


@dataclass(frozen=True)
class Cue:
    id: int
    first: int  # word range [first, last) of the source line
    last: int
    start_ms: int
    end_ms: int
    text: str
    final_ms: int  # media time it goes out as final


@dataclass(frozen=True)
class _Line:
    """One source line: its words, when they were said, and when they were heard."""

    line: CaptionLine
    final_ms: int  # when the line went out final
    heard: tuple[tuple[int, int], ...]  # (words heard, media ms), both rising

    @property
    def words(self) -> list[str]:
        return self.line.text.split()

    def heard_ms(self, n: int) -> int:
        """When the first ``n`` words had been heard (the line's final time once all were)."""
        points = [*self.heard, (len(self.words), self.final_ms)]
        i = next((k for k, (w, _) in enumerate(points) if w >= n), len(points) - 1)
        if i == 0:
            return points[0][1]
        (w0, t0), (w1, t1) = points[i - 1], points[i]
        return t0 + (t1 - t0) * (n - w0) // max(1, w1 - w0)

    def spoken_ms(self) -> list[int]:
        """The media time of each word boundary 0..N, spread over [start_ms, end_ms]."""
        words, start, end = self.words, self.line.start_ms, self.line.end_ms
        span = max(0, end - start)
        if self.heard and self.heard[-1][0] >= MIN_INTERIM_SHARE * len(words) and self.heard[-1][1] > self.heard[0][1]:
            t = [min(self.heard_ms(n), self.heard[-1][1]) for n in range(len(words) + 1)]
            lo, hi = t[0], t[-1]
            return [start + span * (x - lo) // (hi - lo) for x in t]
        chars = _cumulative_chars(words)
        return [start + span * c // max(1, chars[-1]) for c in chars]


def _cumulative_chars(words: Sequence[str]) -> list[int]:
    out = [0]
    for w in words:
        out.append(out[-1] + len(w) + (1 if out[-1] else 0))
    return out


def breaks(words: Sequence[str], spoken: Sequence[int]) -> list[tuple[int, int]]:
    """Word ranges of the cues of one line, ``spoken[n]`` being the time of word boundary n."""

    def chars(i: int, j: int) -> int:
        return sum(len(w) for w in words[i:j]) + max(0, j - i - 1)

    def fits(i: int, j: int) -> bool:
        return chars(i, j) <= MAX_CUE_CHARS and spoken[j] - spoken[i] <= MAX_CUE_MS

    def strong(k: int) -> bool:
        return bool(_STRONG.search(words[k - 1]))

    def medium(k: int) -> bool:
        return bool(_MEDIUM.search(words[k - 1])) or words[k].lower().strip(_QUOTES + "(") in _CONJUNCTIONS

    out: list[tuple[int, int]] = []
    i, n = 0, len(words)
    while i < n:
        j = i + 1
        while j < n and fits(i, j + 1):
            j += 1
        if j == n:
            out.append((i, n))
            break
        k = next(
            (k for good in (strong, medium) for k in range(j, i, -1) if chars(i, k) >= MIN_BREAK_CHARS and good(k)),
            j,
        )
        out.append((i, k))
        i = k
    return out


def line_cues(line: _Line, first_id: int) -> list[Cue]:
    words, spoken = line.words, line.spoken_ms()
    ranges = breaks(words, spoken)
    cues: list[Cue] = []
    for n, (i, j) in enumerate(ranges):
        start, end = spoken[i], spoken[j]
        out = line.final_ms if n == len(ranges) - 1 else min(line.final_ms, max(line.heard_ms(j), end))
        cues.append(Cue(first_id + n, i, j, start, end, " ".join(words[i:j]), out))
    return cues


def _source_lines(snapshots: Sequence[RecordedSnapshot]) -> list[_Line]:
    """Each final line with the interims heard before it went out (the snapshots since the line before)."""
    lines: dict[int, CaptionLine] = {}
    final_ms: dict[int, int] = {}
    heard: dict[int, list[tuple[int, int]]] = {}
    for snap in snapshots:
        state = snap.state
        assert isinstance(state, CaptionsState)
        for line in state.lines:
            if line.id not in lines:
                final_ms[line.id] = snap.media_ms
            lines[line.id] = line
        current = max(lines, default=-1) + 1  # the line the interim is part of
        if state.interim:
            points = heard.setdefault(current, [])
            n = len(state.interim.split())
            if not points or (n > points[-1][0] and snap.media_ms >= points[-1][1]):
                points.append((n, snap.media_ms))
    out: list[_Line] = []
    for i in sorted(lines):
        n = len(lines[i].text.split())
        points = tuple((min(w, n), t) for w, t in heard.get(i, []) if t <= final_ms[i])
        out.append(_Line(lines[i], final_ms[i], points))
    return out


def _captions_snapshots(
    snapshots: Sequence[RecordedSnapshot], source: list[_Line], cues: dict[int, list[Cue]]
) -> list[RecordedSnapshot]:
    """The captions snapshots with cues for lines: each final line's cues (the recorded window of lines), then the
    cues of the line being heard that have gone out, then the rest heard as the interim."""
    by_id = {line.line.id: line for line in source}
    ids = sorted(by_id)
    if not ids:
        return list(snapshots)
    out: list[RecordedSnapshot] = []
    for snap in snapshots:
        state = snap.state
        assert isinstance(state, CaptionsState)
        final = sorted({line.id for line in state.lines if line.id in by_id})
        current = ids[bisect_right(ids, final[-1])] if final and final[-1] < ids[-1] else None if final else ids[0]
        early = [c for c in cues[current] if c.final_ms <= snap.media_ms] if current is not None else []
        shown = [c for i in final for c in cues[i]] + early
        interim = ""
        if current is not None and state.interim:
            words = by_id[current].words
            heard = min(len(state.interim.split()), len(words))
            interim = " ".join(words[early[-1].last if early else 0 : heard])
        lines = [CaptionLine(id=c.id, start_ms=c.start_ms, end_ms=c.end_ms, text=c.text) for c in shown]
        out.append(snap.model_copy(update={"state": state.model_copy(update={"lines": lines, "interim": interim})}))
    return out


def split_translation(source: Sequence[str], cues: Sequence[Cue], translated: str) -> list[str]:
    """The parts of ``translated`` (a translation of the words ``source``) that go with each of ``cues``."""
    en = _sentences(source)
    tr_words = translated.split()
    tr = _sentences(tr_words) if len(_sentences(tr_words)) == len(en) else [(0, len(tr_words))]
    if len(tr) != len(en):
        en = [(0, len(source))]
    en_chars, tr_chars = _cumulative_chars(source), _cumulative_chars(tr_words)

    def to_tr(boundary: int) -> int:
        """The Turkish word boundary that matches English word boundary ``boundary``."""
        s = next((k for k, (_, b) in enumerate(en) if boundary < b), len(en) - 1)
        (a, b), (c, d) = en[s], tr[s]
        share = (en_chars[boundary] - en_chars[a]) / max(1, en_chars[b] - en_chars[a])
        target = tr_chars[c] + share * (tr_chars[d] - tr_chars[c])
        return min(range(c, d + 1), key=lambda k: abs(tr_chars[k] - target))

    cuts = [to_tr(cue.first) for cue in cues] + [len(tr_words)]
    cuts[0] = 0
    return [" ".join(tr_words[cuts[k] : cuts[k + 1]]) for k in range(len(cues))]


def _sentences(words: Sequence[str]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    start = 0
    for k, w in enumerate(words):
        if _STRONG.search(w) or k == len(words) - 1:
            out.append((start, k + 1))
            start = k + 1
    return out or [(0, 0)]


Aligned = Mapping[int, tuple[tuple[str, ...], tuple[str, ...]]]  # source line id -> (cue texts, segments)


def _cues(recorded: Recorded) -> tuple[Sequence[RecordedSnapshot] | None, list[_Line], dict[int, list[Cue]]]:
    """The first captions agent's snapshots, its source lines and their cues (translations follow that agent)."""
    captions = next((s for _, s in recorded if s and isinstance(s[0].state, CaptionsState)), None)
    source = _source_lines(captions) if captions else []
    cues: dict[int, list[Cue]] = {}
    next_id = 0
    for line in source:
        cues[line.line.id] = line_cues(line, next_id)
        next_id += len(cues[line.line.id])
    return captions, source, cues


def cue_texts(recorded: Recorded) -> dict[int, tuple[str, ...]]:
    """Each source caption line's cue texts, by source line id."""
    _, _, cues = _cues(recorded)
    return {i: tuple(c.text for c in line) for i, line in cues.items()}


def resegment(
    recorded: Recorded, aligned: Mapping[str, Aligned] | None = None
) -> list[tuple[AgentInfo, list[RecordedSnapshot]]]:
    """The recording with its caption lines cut into cues and its translations split to match: by ``aligned``
    (per translation agent, ``revise.retranslate``'s segments) where a line's cues are still the same, else by
    ``split_translation``."""
    captions, source, cues = _cues(recorded)
    words = {line.line.id: line.words for line in source}
    out: list[tuple[AgentInfo, list[RecordedSnapshot]]] = []
    for info, snapshots in recorded:
        if captions is not None and snapshots is captions:
            out.append((info, _captions_snapshots(snapshots, source, cues)))
            continue
        if not (snapshots and isinstance(snapshots[0].state, TranslationState) and cues):
            out.append((info, list(snapshots)))
            continue
        given = (aligned or {}).get(info.name, {})
        rewritten: list[RecordedSnapshot] = []
        for snap in snapshots:
            state = snap.state
            assert isinstance(state, TranslationState)
            lines: list[TranslatedLine] = []
            for line in state.lines:
                if line.id not in cues:
                    continue
                texts = tuple(c.text for c in cues[line.id])
                saved = given.get(line.id)
                if saved is not None and saved[0] == texts:
                    parts = list(saved[1])
                else:
                    parts = split_translation(words[line.id], cues[line.id], line.text)
                lines += [TranslatedLine(id=c.id, text=p) for c, p in zip(cues[line.id], parts, strict=True) if p]
            rewritten.append(snap.model_copy(update={"state": state.model_copy(update={"lines": lines})}))
        out.append((info, rewritten))
    return out

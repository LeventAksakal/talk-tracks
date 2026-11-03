#!/usr/bin/env python3
"""Stream one readable line per Meta model call, for the demo video's terminal beside the player. Read-only.

Run on the VM (python3, standard library only; nothing to install):

    python3 ~/talk-tracks/deploy/meta-calls.py --room <room>          # follow, from now
    python3 ~/talk-tracks/deploy/meta-calls.py --since 30 --no-follow # the last 30 minutes, then exit

It reads two things the agents already write under $TT_DATA (default ~/tt-data), and writes nothing:

* the spend ledger, ``ledger.jsonl``: every Muse Spark call reserves its worst case (``reserved for chat <model>
  <what>``) and settles to its real cost (``chat <model> <what>``) on one line each, with the room and a Unix-second
  time; speech recognition pays a minute of audio ahead (``asr <model> 1 min``). A call's cost is its reservation
  plus its settlement, and its latency is the time between them (whole seconds: the ledger keeps no finer time).
* the agents' track archive, ``archive/<room>/agents/<agent>/<track>/<k>.part|.slice`` (one JSON line per object):
  what each call produced. While following, each Muse Spark call is matched with the record its agent published
  next in the same room (a translation cue, a slide description, an outline revision), which names the language and
  gives the input -> output snippet. Final caption lines (Muse Voice Transcribe) are printed as they arrive.

It never prints keys, tokens, hosts or addresses: neither file holds any, and only the fields named above are read.
Token counts are not in either file (they are only in the agents' container logs), so the line shows the cost.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from collections import deque
from pathlib import Path

POLL_S = 0.4
HOLD_S = 2.5  # how long a settled call waits for the record its agent publishes after it
MATCH_S = 12.0  # how long a published record waits for the call that paid for it
LABEL = re.compile(r"^(?P<api>chat|asr) (?P<model>\S+) (?P<what>.+)$")
KINDS = {"translate": "translate", "describe": "describe", "outline": "chapters", "punctuate": "punctuate"}
COLOURS = {"translate": "36", "describe": "35", "chapters": "33", "captions": "32", "punctuate": "34"}


def width_of(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 0 if unicodedata.combining(c) else 1 for c in text)


def clip(text: str, cols: int) -> str:
    text = " ".join(text.split())
    if width_of(text) <= cols:
        return text
    out, used = [], 0
    for c in text:
        w = width_of(c)
        if used + w > cols - 1:
            break
        out.append(c)
        used += w
    return "".join(out) + "…"


class Out:
    def __init__(self, colour: bool, cols: int, show_room: bool) -> None:
        self.colour = colour
        self.cols = cols
        self.show_room = show_room
        self.calls = 0
        self.usd = 0.0

    def paint(self, code: str, text: str) -> str:
        return f"\x1b[{code}m{text}\x1b[0m" if self.colour else text

    def line(self, t: float, room: str, agent: str, kind: str, model: str, stat: str, snippet: str = "") -> None:
        head = time.strftime("%H:%M:%S", time.localtime(t))
        cells = [head]
        if self.show_room:
            cells.append(f"{clip(room, 14):<14}")
        cells += [f"{clip(agent, 14):<14}", f"{clip(model, 25):<25}", f"{stat:>13}"]
        plain = "  ".join(cells)
        room_left = self.cols - width_of(plain) - 2
        snippet = " ".join(snippet.split())
        code = COLOURS.get(kind, "37")
        cells[-3] = self.paint(f"1;{code}", cells[-3])
        cells[0] = self.paint("2", cells[0])
        if snippet and width_of(snippet) <= room_left:  # fits beside the call
            print("  ".join(cells) + "  " + self.paint(code, snippet), flush=True)
            return
        print("  ".join(cells), flush=True)
        if snippet:  # on its own line below, indented under the agent
            print("          " + self.paint(code, clip(snippet, max(20, self.cols - 10))), flush=True)


class Ledger:
    """Turns ledger lines into calls: (time, room, kind, model, usd, latency_s or None, backfill)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.offset = 0
        self.held: dict[tuple[str, str], deque[tuple[int, float]]] = {}

    def skip_to_end(self) -> None:
        self.offset = self.path.stat().st_size if self.path.exists() else 0

    def read(self) -> list[dict]:
        if not self.path.exists():
            return []
        size = self.path.stat().st_size
        if size < self.offset:  # replaced or truncated: start again
            self.offset = 0
        if size == self.offset:
            return []
        with self.path.open("rb") as f:
            f.seek(self.offset)
            data = f.read()
        end = data.rfind(b"\n") + 1  # a line still being written waits for the next read
        self.offset += end
        calls = []
        for raw in data[:end].decode("utf-8", "replace").splitlines():
            call = self.feed(raw)
            if call is not None:
                calls.append(call)
        return calls

    def feed(self, raw: str) -> dict | None:
        try:
            line = json.loads(raw)
            t, usd, what = int(line["t"]), float(line["usd"]), str(line["what"])
        except (ValueError, KeyError, TypeError):
            return None
        room = str(line.get("room") or "-")
        if what.startswith("reserved for "):
            self.held.setdefault((room, what[len("reserved for ") :]), deque()).append((t, usd))
            return None
        refused = what.startswith("released ")
        label = what[len("released ") :] if refused else what
        held = self.held.get((room, label))
        t0, reserved = held.popleft() if held else (None, 0.0)
        m = LABEL.match(label)
        if m is None:
            return None  # not a Meta call (a test provider, a back-fill budget line)
        api, model, rest = m.group("api"), m.group("model"), m.group("what")
        kind = "captions" if api == "asr" else KINDS.get(rest, rest)
        return {
            "t": t,
            "room": room,
            "kind": kind,
            "model": model,
            "usd": round(reserved + usd, 6),
            "latency": None if t0 is None else t - t0,
            "backfill": bool(line.get("backfill")),
            "refused": refused,
            "audio_min": api == "asr",
        }


class Archive:
    """New records the agents publish, read from the ends of their slice files."""

    def __init__(self, root: Path, room: str | None) -> None:
        self.root = root
        self.room = room
        self.seen: dict[tuple[str, str], int] = {}  # (track dir, slice number) -> lines read
        self.captions: dict[tuple[str, str], str] = {}  # (room, cue id) -> final caption text

    def dirs(self) -> list[tuple[str, str, Path]]:
        out = []
        rooms = [self.root / self.room] if self.room else sorted(p for p in self.root.glob("*") if p.is_dir())
        for room_dir in rooms:
            agents = room_dir / "agents"
            if not agents.is_dir():
                continue
            for agent_dir in sorted(agents.iterdir()):
                for track in ("items", "outline"):
                    d = agent_dir / track
                    if d.is_dir():
                        out.append((room_dir.name, agent_dir.name, d))
        return out

    def scan(self, emit: bool) -> list[dict]:
        events = []
        for room, agent, d in self.dirs():
            try:
                names = sorted(n for n in os.listdir(d) if n.endswith((".part", ".slice")))
            except OSError:
                continue
            latest: dict[str, str] = {}
            for n in names:  # one file per slice: a finished .slice wins over its .part
                k, ext = n.rsplit(".", 1)
                if ext == "slice" or k not in latest:
                    latest[k] = n
            for k in sorted(latest)[-2:]:
                key = (str(d), k)
                try:
                    text = (d / latest[k]).read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                start = self.seen.get(key, 0)
                complete = text[: text.rfind("\n") + 1].splitlines()  # a line still being written waits
                for raw in complete[start:]:
                    events += self.records(room, agent, d.name, raw, emit)
                self.seen[key] = max(start, len(complete))
        return events

    def records(self, room: str, agent: str, track: str, raw: str, emit: bool) -> list[dict]:
        try:
            obj = json.loads(raw)
            if "t" not in obj:
                return []
            items = json.loads(obj["t"])
        except (ValueError, TypeError):
            return []
        first = obj.get("o") == 0
        if not isinstance(items, list):
            return []
        if track == "outline":
            if not first:
                return []
            chapters = [r["data"] for r in items if isinstance(r, dict) and r.get("data", {}).get("kind") == "chapter"]
            terms = sum(1 for r in items if isinstance(r, dict) and r.get("data", {}).get("kind") == "term")
            last = chapters[-1].get("title", "") if chapters else ""
            text = f"{len(chapters)} chapters, {terms} glossary term{'' if terms == 1 else 's'} · latest: “{last}”"
            return [{"room": room, "kind": "chapters", "agent": "chapters", "text": text}] if emit else []
        if first:  # object 0 is the carry-in: cues already published
            if agent == "captions":
                for r in items:
                    self.remember(room, r)
            return []
        out = []
        for r in items:
            data = r.get("data", {}) if isinstance(r, dict) else {}
            if "text" not in data:
                continue
            if agent == "captions":
                if data.get("final") and self.remember(room, r) and emit:
                    out.append({"room": room, "kind": "captions", "agent": "captions", "text": f"“{data['text']}”"})
            elif agent.startswith("translate-"):
                lang = agent[len("translate-") :]
                source = self.captions.get((room, str(data.get("id"))), "")
                text = f"“{source}” → “{data['text']}”" if source else f"→ “{data['text']}”"
                out.append({"room": room, "kind": "translate", "agent": f"translate {lang}", "text": text})
            elif agent == "describe":
                out.append({"room": room, "kind": "describe", "agent": "describe slide", "text": f"“{data['text']}”"})
        return out if emit else []

    def remember(self, room: str, record: object) -> bool:
        data = record.get("data", {}) if isinstance(record, dict) else {}
        if not data.get("final") or "id" not in data:
            return False
        key = (room, str(data["id"]))
        new = self.captions.get(key) != data.get("text")
        self.captions[key] = str(data.get("text", ""))
        if len(self.captions) > 2000:
            for old in list(self.captions)[:500]:
                del self.captions[old]
        return new


def stat_of(call: dict) -> str:
    if call["audio_min"]:
        return f"1 min ${call['usd']:.4f}"
    if call["refused"]:
        return "refused, $0"
    lat = call["latency"]
    took = "" if lat is None else ("<1s " if lat <= 0 else f"~{lat}s ")
    return f"{took}${call['usd']:.4f}"


def show_call(out: Out, call: dict, record: dict | None) -> None:
    agent = record["agent"] if record else {"captions": "captions"}.get(call["kind"], call["kind"])
    if call["backfill"]:
        agent += " ⟲"
    snippet = record["text"] if record else ("audio paid a minute ahead" if call["audio_min"] else "")
    out.calls += 1
    out.usd += call["usd"]
    out.line(call["t"], call["room"], agent, call["kind"], call["model"], stat_of(call), snippet)


def main() -> int:
    p = argparse.ArgumentParser(description="One line per Meta model call, from the spend ledger and the archive.")
    p.add_argument("--data", type=Path, default=Path(os.environ.get("TT_DATA", "~/tt-data")).expanduser())
    p.add_argument("--room", help="only this room (default: every room)")
    p.add_argument("--since", type=float, default=0, help="also show the last N minutes of calls first")
    p.add_argument("--no-follow", action="store_true", help="print the --since window and exit")
    p.add_argument("--no-captions", action="store_true", help="leave out the caption lines")
    p.add_argument("--width", type=int, default=0, help="columns (default: the terminal's)")
    p.add_argument("--no-colour", "--no-color", action="store_true")
    args = p.parse_args()

    if args.room and not re.fullmatch(r"[a-z0-9-]{1,60}", args.room):
        p.error("a room name is a-z, 0-9 and -")
    cols = args.width or os.get_terminal_size(sys.stdout.fileno()).columns if sys.stdout.isatty() else args.width or 110
    out = Out(sys.stdout.isatty() and not args.no_colour, cols, show_room=args.room is None)
    ledger = Ledger(args.data / "ledger.jsonl")
    archive = Archive(args.data / "archive", args.room)

    def wanted(room: str) -> bool:
        return args.room is None or room == args.room

    if args.since > 0:  # history: the ledger only (what each call produced is matched only while following)
        cutoff = time.time() - args.since * 60
        for call in ledger.read():
            if call["t"] >= cutoff and wanted(call["room"]):
                show_call(out, call, None)
    else:
        ledger.skip_to_end()
    if args.no_follow:
        print(f"{out.calls} calls, ${out.usd:.4f}")
        return 0

    archive.scan(emit=False)  # what is there already: remember the captions, print nothing
    room = f"room {args.room}" if args.room else "every room"
    print(out.paint("2", f"Meta model calls · {room} · Ctrl-C to stop"), flush=True)
    pending: list[tuple[float, dict]] = []  # settled calls waiting for their record
    records: list[tuple[float, dict]] = []  # published records waiting for their call
    try:
        while True:
            now = time.monotonic()
            pending += [(now, c) for c in ledger.read() if wanted(c["room"])]
            for ev in archive.scan(emit=True):
                if ev["kind"] == "captions":
                    if not args.no_captions:
                        out.line(
                            time.time(),
                            ev["room"],
                            "captions",
                            "captions",
                            "muse-voice-transcribe-1.0",
                            "turn",
                            ev["text"],
                        )
                else:
                    records.append((now, ev))
            records = [(at, ev) for at, ev in records if now - at < MATCH_S]
            keep = []
            for at, call in pending:
                match = next(
                    (
                        i
                        for i, (_, ev) in enumerate(records)
                        if (ev["room"], ev["kind"]) == (call["room"], call["kind"])
                    ),
                    None,
                )
                if match is not None:
                    show_call(out, call, records.pop(match)[1])
                elif call["audio_min"] or call["refused"] or now - at >= HOLD_S:
                    show_call(out, call, None)
                else:
                    keep.append((at, call))
            pending = keep
            time.sleep(POLL_S)
    except KeyboardInterrupt:
        print(out.paint("2", f"\n{out.calls} calls, ${out.usd:.4f}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

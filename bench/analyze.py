"""Summarise the runner's JSON lines (bench/results/*.jsonl) as the tables in wiki/benchmark.md. Standard library only.

    python bench/analyze.py bench/results/local.jsonl [more.jsonl ...] [--warmup-s 5]

Per label (one network condition) and protocol:
  join      first decoded frame after the player was created, over all joins (p50, p95)
  latency   glass-to-glass of every rendered frame after the first --warmup-s seconds of each join, pooled (p50, p95,
            p99): the steady state a viewer sits in. The first seconds are reported apart as "first-frame latency",
            since players differ in how they catch up to live
  text      publish-to-receive of the JSON text track, MoQ only
  stalls    gaps of more than 250 ms between rendered frames (the source runs at 25 fps), per minute of playback
  fetch     (proto fetch) `fetchGroup` of one 4 s slice of the history track: an archive slice the relay has not
            seen (served by the origin), the same again (the relay's cache), and the newest slice received whole live;
            ms to the group's end, pooled over all rounds; bytes per slice against a full media viewer's 4 s; and how
            often the slice open at join came back, fetched at once (while open), after the rounds, and from a second session
  served    (proto fetch) every FETCH by who answered it: the origin, when its log (LABEL.origin.log next to
            LABEL.jsonl, written by historypub.py) has a FETCH of that group while it ran, else the relay's cache
  per track bytes per 4 s slice for each track a viewer can opt into: the history track's payload as received live,
            the text track and the full media from their rows' interface counters
  received  bytes per second into the viewer container over a whole join (its interface counter: headers,
            playlists and retransmissions included, the same count for every protocol)
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

STALL_MS = 250
ORDER = ["moq", "moq-ws", "moq-text", "webrtc", "hls"]
NAMES = {
    "moq": "MoQ (WebTransport)",
    "moq-ws": "MoQ (WebSocket fallback)",
    "moq-text": "MoQ, text track only",
    "webrtc": "WebRTC (WHEP)",
    "hls": "LL-HLS (hls.js)",
}


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return math.nan
    s = sorted(xs)
    return s[min(len(s) - 1, int(p / 100 * len(s)))]


def fmt(x: float) -> str:
    return "–" if math.isnan(x) else f"{x:.0f}"


def summarise(lines: list[dict], warmup_ms: float) -> dict[tuple[str, str], dict]:
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for line in lines:
        if line["proto"] == "fetch":
            continue  # its own table: fetch_table()
        groups[(line["label"], line["proto"])].append(line)
    out = {}
    for key, runs in groups.items():
        ok = [r for r in runs if r.get("frames") or r.get("text")]
        steady = [lat for r in ok for t, lat in r["frames"] if t >= warmup_ms]
        first = [r["frames"][0][1] for r in ok if r["frames"]]
        text = [lat for r in ok for _, lat in r.get("text", [])]
        sent = [(r["rxBytes"], r["rxMs"]) for r in ok if r.get("rxBytes") is not None and r.get("rxMs")]
        stalls = 0
        played_ms = 0.0
        for r in ok:
            ts = [t for t, _ in r["frames"]]
            if not ts:
                continue
            stalls += sum(1 for a, b in zip(ts, ts[1:]) if b - a > STALL_MS)
            played_ms += ts[-1] - ts[0] if len(ts) > 1 else 0
        frames = sum(len(r["frames"]) for r in ok)
        unreadable = sum(r.get("unreadable", 0) for r in ok)
        out[key] = {
            "runs": len(runs),
            "failed": len(runs) - len(ok),
            "transports": sorted({r.get("transport") or "-" for r in ok}),
            "join": [r["joinMs"] for r in ok if r.get("joinMs") is not None],
            "first": first,
            "steady": steady,
            "text": text,
            "stalls_per_min": stalls / (played_ms / 60_000) if played_ms else math.nan,
            "unreadable_pct": 100 * unreadable / (frames + unreadable) if frames + unreadable else math.nan,
            "kbit_s": 8 * sum(b for b, _ in sent) / sum(ms for _, ms in sent) if sent else math.nan,
            "network": runs[0].get("network", {}),
            "chrome": runs[0].get("chrome", "?"),
        }
    return out


def table(summary: dict[tuple[str, str], dict]) -> str:
    rows = [
        "| Condition | Protocol | Joins (failed) | Join p50 / p95 ms | Latency p50 / p95 / p99 ms | First-frame latency p50 ms "
        "| Text p50 / p95 ms | Stalls per min | Received kbit/s |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for (label, proto), s in sorted(summary.items(), key=lambda kv: (kv[0][0], ORDER.index(kv[0][1]))):
        text = f"{fmt(pct(s['text'], 50))} / {fmt(pct(s['text'], 95))}" if s["text"] else "not carried"
        rows.append(
            f"| {label} | {NAMES.get(proto, proto)} | {s['runs']} ({s['failed']}) "
            f"| {fmt(pct(s['join'], 50))} / {fmt(pct(s['join'], 95))} "
            f"| {fmt(pct(s['steady'], 50))} / {fmt(pct(s['steady'], 95))} / {fmt(pct(s['steady'], 99))} "
            f"| {fmt(pct(s['first'], 50))} | {text} | {s['stalls_per_min']:.1f} | {fmt(s['kbit_s'])} |"
        )
    return "\n".join(rows)


def fetch_table(lines: list[dict], summary: dict[tuple[str, str], dict]) -> str:
    rows = [
        "| Condition | Joins | Rounds (failed) | Uncached p50 / p95 ms | Cached p50 / p95 ms | Recent p50 / p95 ms "
        "| Bytes per slice | Full media per 4 s | Join slice fetched while open / later / other session |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    by_label: dict[str, list[dict]] = defaultdict(list)
    for line in lines:
        if line["proto"] == "fetch":
            by_label[line["label"]].append(line)
    for label, runs in sorted(by_label.items()):
        rounds = [f for r in runs for f in r.get("fetches") or []]
        ms = {k: [f[k]["ms"] for f in rounds if k in f] for k in ("uncached", "cached", "recent")}
        slice_bytes = [f["uncached"]["bytes"] for f in rounds if "uncached" in f]
        joined = [r.get("joinSlice") or {} for r in runs]
        media = summary.get((label, "moq"), {}).get("kbit_s", math.nan)
        rows.append(
            f"| {label} | {len(runs)} | {len(rounds)} ({sum(1 for f in rounds if f.get('errors'))}) "
            + " ".join(f"| {fmt(pct(ms[k], 50))} / {fmt(pct(ms[k], 95))}" for k in ("uncached", "cached", "recent"))
            + f" | {fmt(pct(slice_bytes, 50))} | {fmt(media * 4000 / 8)} "
            f"| {sum(1 for j in joined if j.get('open'))} / {sum(1 for j in joined if j.get('fetched'))} / {sum(1 for j in joined if j.get('fresh'))} of {len(joined)} |"
        )
    return "\n".join(rows)


def origin_logs(files: list[Path]) -> dict[str, list[dict]]:
    """The FETCHes the history origin served, per label, from LABEL.origin.log beside each LABEL.jsonl."""
    out: dict[str, list[dict]] = {}
    for f in files:
        log = f.with_name(f.stem + ".origin.log")
        if log.exists():
            out[f.stem] = [json.loads(x) for x in log.read_text().splitlines() if x.strip()]
    return out


def all_fetches(run: dict) -> list[tuple[str, dict]]:
    """Every timed fetch of a fetch-row join, with its kind."""
    out = [(k, f[k]) for f in run.get("fetches") or [] for k in ("uncached", "cached", "recent") if k in f]
    js = run.get("joinSlice") or {}
    out += [(f"join slice {k}", js[k]) for k in ("open", "fetched", "fresh") if k in js]
    return out


def origin_served(fetches: list[dict], served: list[dict]) -> set[int]:
    """The fetches (by id()) the origin answered. Each standalone FETCH (type 1) in its log goes to the fetch of that
    group that was running when the origin got it: started before it (2 ms of slack for the clock's resolution; one
    host, one clock) and not yet over. A repeat started right after the first ended is not counted for it."""
    hits: set[int] = set()
    for s in served:
        if s["fetchType"] != 1:
            continue
        cands = [f for f in fetches if f["group"] == s["group"] and f["atMs"] - 2 <= s["t"] <= f["atMs"] + f["ms"] + 2]
        if cands:
            hits.add(id(max(cands, key=lambda f: f["atMs"])))
    return hits


def served_table(lines: list[dict], logs: dict[str, list[dict]]) -> str:
    rows = [
        "| Condition | Served by | Fetches | p50 / p95 ms, to the end of the group | Of which uncached / cached / recent |",
        "|---|---|---|---|---|",
    ]
    by: dict[tuple[str, str], list[tuple[str, dict]]] = defaultdict(list)
    for label in sorted({r["label"] for r in lines if r["proto"] == "fetch"}):
        fs = [kf for r in lines if r["label"] == label and r["proto"] == "fetch" for kf in all_fetches(r)]
        timed = [f for _, f in fs if "atMs" in f]
        hits = origin_served(timed, logs[label]) if label in logs else set()
        for kind, f in fs:
            who = "unknown" if "atMs" not in f or label not in logs else "origin" if id(f) in hits else "relay cache"
            by[(label, who)].append((kind, f))
    for (label, who), fs in sorted(by.items()):
        ms = [f["ms"] for _, f in fs]
        kinds = " / ".join(str(sum(1 for k, _ in fs if k == x)) for x in ("uncached", "cached", "recent"))
        rows.append(f"| {label} | {who} | {len(fs)} | {fmt(pct(ms, 50))} / {fmt(pct(ms, 95))} | {kinds} |")
    return "\n".join(rows)


def per_track_table(lines: list[dict], summary: dict[tuple[str, str], dict]) -> str:
    rows = ["| Condition | Track opted in | Bytes per 4 s slice | Measured as |", "|---|---|---|---|"]
    for label in sorted({r["label"] for r in lines}):
        hist = [
            b
            for r in lines
            if r["label"] == label and r["proto"] == "fetch"
            for g, _, b in (r.get("slices") or [])
            if g != (r.get("joinSlice") or {}).get("group")
        ]
        if hist:
            rows.append(f"| {label} | history `items` (a captions-sized AI track) | {fmt(pct(hist, 50))} | payload, whole slices received live |")
        for proto, what in (("moq-text", "text `state`, 4 objects a second"), ("moq", "everything: video, audio and text")):
            k = summary.get((label, proto), {}).get("kbit_s", math.nan)
            if not math.isnan(k):
                rows.append(f"| {label} | {what} | {fmt(k * 4000 / 8)} | on the wire, the {proto} row |")
    return "\n".join(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--warmup-s", type=float, default=5)
    ap.add_argument("--json", type=Path, help="also write the summary statistics as JSON here")
    args = ap.parse_args()
    lines = [json.loads(x) for f in args.files for x in f.read_text().splitlines() if x.strip()]
    summary = summarise(lines, args.warmup_s * 1000)
    print(table(summary))
    print()
    if any(x["proto"] == "fetch" for x in lines):
        print(fetch_table(lines, summary))
        print()
        print(served_table(lines, origin_logs(args.files)))
        print()
    print(per_track_table(lines, summary))
    print()
    for (label, proto), s in sorted(summary.items()):
        print(
            f"- {label} / {proto}: transports {', '.join(s['transports'])}; network {s['network']}; "
            f"unreadable frames {s['unreadable_pct']:.1f} %; Chrome {s['chrome']}"
        )
    if args.json:
        fetch_rounds = defaultdict(list)
        for x in lines:
            if x["proto"] == "fetch":
                fetch_rounds[x["label"]] += x.get("fetches") or []
        stats = {
            f"{label}/fetch": {
                k + "_" + q: pct([f[k]["ms"] for f in rounds if k in f], int(q[1:]))
                for k in ("uncached", "cached", "recent")
                for q in ("p50", "p95")
            }
            for label, rounds in fetch_rounds.items()
        } | {
            f"{label}/{proto}": {
                "runs": s["runs"],
                "failed": s["failed"],
                "join_p50": pct(s["join"], 50),
                "join_p95": pct(s["join"], 95),
                "latency_p50": pct(s["steady"], 50),
                "latency_p95": pct(s["steady"], 95),
                "latency_p99": pct(s["steady"], 99),
                "text_p50": pct(s["text"], 50),
                "text_p95": pct(s["text"], 95),
                "stalls_per_min": s["stalls_per_min"],
                "kbit_s": s["kbit_s"],
            }
            for (label, proto), s in summary.items()
        }
        args.json.write_text(json.dumps(stats, indent=2) + "\n")


if __name__ == "__main__":
    main()

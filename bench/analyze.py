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

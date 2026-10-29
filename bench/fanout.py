"""Lightweight fan-out benchmark harness (Decision 0016 / Tickets 0016 & 0017).

Measures server CPU (% of 1 core), RSS memory (MiB), and TX egress (total Mbit/s
and per-viewer kbit/s) at N = 1, 10, and 100 concurrent viewers across:
  - moq-full: N subscribers receiving video + audio + text from relay.
  - moq-captions: N subscribers receiving text only (selective subscription).
  - hls: N async HTTP LL-HLS playlist/part pollers against mediamtx:8888.
  - webrtc: N WHEP subscribers against mediamtx:8889.

Protocol clients are lightweight: they drain packets without video rendering
or decoding so client load does not distort server CPU on a shared host.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

log = logging.getLogger("bench.fanout")

PROTOCOLS = ["moq-full", "moq-captions", "webrtc", "hls"]
CONCURRENCIES = [1, 10, 100]

SERVER_FOR_PROTO = {
    "moq-full": "relay",
    "moq-captions": "relay",
    "hls": "mediamtx",
    "webrtc": "mediamtx",
}


# ---------------------------------------------------------------------------
# Docker Stats Monitoring (via Unix domain socket / Docker Engine API)
# ---------------------------------------------------------------------------


class DockerMonitor:
    """Queries container resource usage over /var/run/docker.sock or docker CLI."""

    def __init__(self, sock_path: str = "/var/run/docker.sock") -> None:
        self.sock_path = sock_path
        self._has_sock = os.path.exists(sock_path)
        self._id_cache: dict[str, str] = {}

    async def _query_socket(self, path: str) -> dict[str, Any] | list[Any] | None:
        if not self._has_sock:
            return None
        try:
            reader, writer = await asyncio.open_unix_connection(self.sock_path)
            req = f"GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
            writer.write(req.encode())
            await writer.drain()
            resp = b""
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                resp += chunk
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
            _, _, body = resp.partition(b"\r\n\r\n")
            if not body:
                return None
            return json.loads(body.decode("utf-8", errors="replace"))
        except Exception as exc:
            log.debug("Docker socket query error on %s: %s", path, exc)
            return None

    async def resolve_container_id(self, name_hint: str) -> str:
        if name_hint in self._id_cache:
            return self._id_cache[name_hint]
        # Try Docker socket listing
        containers = await self._query_socket("/containers/json")
        if isinstance(containers, list):
            for c in containers:
                names = c.get("Names", [])
                if any(name_hint in n for n in names):
                    cid = str(c.get("Id", ""))
                    self._id_cache[name_hint] = cid
                    return cid
        # Fallback to docker CLI if on host
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker",
                "ps",
                "--filter",
                f"name={name_hint}",
                "--format",
                "{{.ID}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await proc.communicate()
            cid = stdout.decode().strip().splitlines()[0] if stdout else ""
            if cid:
                self._id_cache[name_hint] = cid
                return cid
        except Exception:
            pass
        return name_hint

    async def sample(self, name_hint: str) -> dict[str, float] | None:
        cid = await self.resolve_container_id(name_hint)
        data = await self._query_socket(f"/containers/{cid}/stats?stream=false")
        if isinstance(data, dict):
            try:
                cpu_total = float(data["cpu_stats"]["cpu_usage"]["total_usage"])
                mem_stats = data.get("memory_stats", {})
                # cgroups v2 uses 'anon' for RSS, v1 uses 'rss'
                stats_dict = mem_stats.get("stats", {})
                rss = float(stats_dict.get("anon") or stats_dict.get("rss") or mem_stats.get("usage", 0.0))
                # Sum tx_bytes across all interfaces
                networks = data.get("networks", {})
                tx_bytes = float(sum(iface.get("tx_bytes", 0.0) for iface in networks.values()))
                return {
                    "time": time.monotonic(),
                    "cpu_ns": cpu_total,
                    "mem_bytes": rss,
                    "tx_bytes": tx_bytes,
                }
            except KeyError:
                pass

        # Fallback: parse docker stats CLI output
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker",
                "stats",
                cid,
                "--no-stream",
                "--format",
                "{{json .}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await proc.communicate()
            if stdout:
                entry = json.loads(stdout.decode().strip().splitlines()[0])
                cpu_str = str(entry.get("CPUPerc", "0%")).rstrip("%")
                cpu_pct = float(cpu_str) if cpu_str else 0.0
                mem_str = str(entry.get("MemUsage", "0MiB / 0GiB")).split("/")[0].strip()
                mem_bytes = parse_byte_size(mem_str)
                net_str = str(entry.get("NetIO", "0B / 0B")).split("/")[1].strip()
                tx_bytes = parse_byte_size(net_str)
                return {
                    "time": time.monotonic(),
                    "cpu_direct_pct": cpu_pct,
                    "mem_bytes": float(mem_bytes),
                    "tx_bytes": float(tx_bytes),
                }
        except Exception as exc:
            log.debug("Docker stats CLI sample error: %s", exc)
        return None


def parse_byte_size(s: str) -> int:
    """Parse '5.49MiB', '126kB', '2GB' into integer bytes."""
    m = re.match(r"^([\d.]+)\s*([A-Za-z]+)$", s.strip())
    if not m:
        return 0
    val = float(m.group(1))
    unit = m.group(2).lower()
    multipliers = {
        "b": 1,
        "k": 1000,
        "kb": 1000,
        "kib": 1024,
        "m": 1000 * 1000,
        "mb": 1000 * 1000,
        "mib": 1024 * 1024,
        "g": 1000 * 1000 * 1000,
        "gb": 1000 * 1000 * 1000,
        "gib": 1024 * 1024 * 1024,
    }
    return int(val * multipliers.get(unit, 1))


# ---------------------------------------------------------------------------
# Protocol Clients
# ---------------------------------------------------------------------------


async def run_moq_viewer(
    relay_url: str,
    tracks: list[tuple[str, str]],
    stop_event: asyncio.Event,
) -> None:
    """Lightweight MoQ subscriber: drains QUIC objects without decoding."""
    try:
        from aiomoqt.agent import AgentSession, StartAt, SubscribeSpec, TrackRef
        from aiomoqt.client import MOQTClient
        from aiopquic.quic.configuration import QuicConfiguration
    except ImportError:
        # aiomoqt is Linux/container-only in this repository
        log.warning("aiomoqt not installed; skipping live QUIC subscription")
        await stop_event.wait()
        return

    u = urlsplit(relay_url)
    host = u.hostname or "relay"
    port = u.port or 4443

    cfg = QuicConfiguration(
        is_client=True,
        max_data=2**24,
        max_stream_data=2**24,
        max_datagram_frame_size=64 * 1024,
    )
    cfg.idle_timeout = 10.0
    cfg.keep_alive_interval = 1.0

    client = MOQTClient(
        host,
        port,
        use_quic=u.scheme == "moqt",
        verify_tls=False,
        supported_drafts=18,
        configuration=cfg,
    )

    try:
        async with client.connect() as session:
            await session.client_session_init()
            agent = AgentSession(session)
            readers = []
            for ns, trk in tracks:
                try:
                    ref = TrackRef(namespace=ns, name=trk)
                    r = await agent.reader(SubscribeSpec(track=ref, start_at=StartAt(mode="latest"), buffer=1024))
                    readers.append(r)
                except Exception as exc:
                    log.debug("Subscribe %s/%s failed: %s", ns, trk, exc)

            async def drain(reader: Any) -> None:
                while not stop_event.is_set() and not reader.done:
                    batch = await reader.read(1, timeout=0.1)
                    batch += reader.drain()
                    await asyncio.sleep(0.01)

            drainers = [asyncio.create_task(drain(r)) for r in readers]
            await stop_event.wait()
            for d in drainers:
                d.cancel()
            with contextlib.suppress(Exception):
                await asyncio.gather(*drainers)
    except Exception as exc:
        log.debug("MoQ viewer session error: %s", exc)


async def run_hls_viewer(
    base_url: str,
    stop_event: asyncio.Event,
) -> None:
    """Lightweight LL-HLS poller: requests playlist and part segments, draining bytes."""
    try:
        import httpx
    except ImportError:
        log.warning("httpx not installed; skipping LL-HLS polling")
        await stop_event.wait()
        return

    playlist_url = f"{base_url.rstrip('/')}:8888/bench/index.m3u8"
    part_base = f"{base_url.rstrip('/')}:8888/bench"
    seen: set[str] = set()

    async with httpx.AsyncClient(timeout=5.0) as client:
        while not stop_event.is_set():
            try:
                r = await client.get(playlist_url)
                if r.status_code == 200:
                    for line in r.text.splitlines():
                        line = line.strip()
                        part_uri = None
                        if 'URI="' in line:
                            part_uri = line.split('URI="')[1].split('"')[0]
                        elif line and not line.startswith("#"):
                            part_uri = line

                        if part_uri and part_uri not in seen:
                            seen.add(part_uri)
                            url = part_uri if part_uri.startswith("http") else f"{part_base}/{part_uri}"
                            async with client.stream("GET", url) as resp:
                                async for _ in resp.aiter_bytes(chunk_size=16384):
                                    pass
            except Exception as exc:
                log.debug("HLS poller error: %s", exc)
            await asyncio.sleep(0.15)


async def run_webrtc_viewer(
    base_url: str,
    stop_event: asyncio.Event,
) -> None:
    """Lightweight WHEP subscriber: establishes PeerConnection, draining SRTP without video decode."""
    try:
        import aiortc.codecs
        import httpx
        from aiortc import RTCPeerConnection, RTCRSessionDescription

        # Patch codec decoder to no-op so video frames are not decoded in software
        class NoOpDecoder:
            def decode(self, *args: Any, **kwargs: Any) -> list[Any]:
                return []

        aiortc.codecs.get_decoder = lambda _codec: NoOpDecoder()
    except ImportError:
        log.warning("aiortc or httpx not installed; skipping WebRTC subscriber")
        await stop_event.wait()
        return

    whep_url = f"{base_url.rstrip('/')}:8889/bench/whep"
    pc = RTCPeerConnection()
    pc.addTransceiver("video", direction="recvonly")
    pc.addTransceiver("audio", direction="recvonly")

    location: str | None = None
    try:
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                whep_url,
                content=pc.localDescription.sdp,
                headers={"Content-Type": "application/sdp"},
            )
            if resp.status_code in (200, 201):
                location = resp.headers.get("Location")
                answer = RTCRSessionDescription(sdp=resp.text, type="answer")
                await pc.setRemoteDescription(answer)

        await stop_event.wait()
    except Exception as exc:
        log.debug("WebRTC viewer error: %s", exc)
    finally:
        with contextlib.suppress(Exception):
            await pc.close()
        if location:
            delete_url = location if location.startswith("http") else f"{whep_url}/{location.lstrip('/')}"
            with contextlib.suppress(Exception):
                async with httpx.AsyncClient(timeout=2.0) as client:
                    await client.delete(delete_url)


# ---------------------------------------------------------------------------
# Fan-Out Runner & Orchestration
# ---------------------------------------------------------------------------


def make_viewer_task(
    proto: str,
    relay_url: str,
    mediamtx_url: str,
    stop_event: asyncio.Event,
) -> asyncio.Task[None]:
    if proto == "moq-full":
        tracks = [("bench/live", "video"), ("bench/live", "audio"), ("bench/text", "state")]
        return asyncio.create_task(run_moq_viewer(relay_url, tracks, stop_event))
    elif proto == "moq-captions":
        tracks = [("bench/text", "state")]
        return asyncio.create_task(run_moq_viewer(relay_url, tracks, stop_event))
    elif proto == "hls":
        return asyncio.create_task(run_hls_viewer(mediamtx_url, stop_event))
    elif proto == "webrtc":
        return asyncio.create_task(run_webrtc_viewer(mediamtx_url, stop_event))
    else:
        raise ValueError(f"Unknown protocol: {proto}")


async def measure_round(
    proto: str,
    n: int,
    monitor: DockerMonitor,
    relay_url: str,
    mediamtx_url: str,
    warmup_s: float,
    duration_s: float,
    mock: bool = False,
) -> dict[str, Any]:
    server_name = SERVER_FOR_PROTO[proto]
    log.info("Starting %s at N=%d viewers (measuring server %s)...", proto, n, server_name)

    if mock:
        await asyncio.sleep(1.0)
        # Realistic mock numbers matching Talk Tracks benchmark findings
        mock_data = {
            "moq-full": (1.5 * n**0.8, 32.0 + 0.08 * n, 0.98 * n),
            "moq-captions": (0.2 * n**0.5, 12.0 + 0.01 * n, 0.008 * n),
            "webrtc": (3.5 * n**0.9, 45.0 + 0.22 * n, 1.15 * n),
            "hls": (2.8 * n**0.85, 38.0 + 0.16 * n, 2.45 * n),
        }
        cpu_pct, mem_mib, tx_mbit = mock_data.get(proto, (1.0, 30.0, 1.0))
        return {
            "proto": proto,
            "n": n,
            "server": server_name,
            "duration_s": duration_s,
            "cpu_pct": round(cpu_pct, 1),
            "mem_mib": round(mem_mib, 1),
            "tx_mbit_s": round(tx_mbit, 2),
            "per_viewer_kbit_s": round((tx_mbit * 1000.0) / n, 1),
        }

    stop_event = asyncio.Event()
    viewers = [make_viewer_task(proto, relay_url, mediamtx_url, stop_event) for _ in range(n)]

    log.info("Warming up for %.1f s...", warmup_s)
    await asyncio.sleep(warmup_s)

    s0 = await monitor.sample(server_name)
    t0 = time.monotonic()
    log.info("Measuring server %s for %.1f s...", server_name, duration_s)
    await asyncio.sleep(duration_s)
    s1 = await monitor.sample(server_name)
    t1 = time.monotonic()

    stop_event.set()
    with contextlib.suppress(Exception):
        await asyncio.gather(*viewers, return_exceptions=True)

    dt = max(0.1, t1 - t0)
    cpu_pct = 0.0
    mem_mib = 0.0
    tx_mbit_s = 0.0

    if s0 and s1:
        if "cpu_ns" in s0 and "cpu_ns" in s1:
            cpu_delta = max(0.0, s1["cpu_ns"] - s0["cpu_ns"])
            cpu_pct = (cpu_delta / (dt * 1e9)) * 100.0
        elif "cpu_direct_pct" in s1:
            cpu_pct = s1["cpu_direct_pct"]

        mem_bytes = s1.get("mem_bytes", 0.0)
        mem_mib = mem_bytes / (1024.0 * 1024.0)

        tx_delta = max(0.0, s1.get("tx_bytes", 0.0) - s0.get("tx_bytes", 0.0))
        tx_mbit_s = (tx_delta * 8.0) / (dt * 1e6)

    per_viewer_kbit_s = (tx_mbit_s * 1000.0) / n if n > 0 else 0.0

    return {
        "proto": proto,
        "n": n,
        "server": server_name,
        "duration_s": dt,
        "cpu_pct": round(cpu_pct, 1),
        "mem_mib": round(mem_mib, 1),
        "tx_mbit_s": round(tx_mbit_s, 2),
        "per_viewer_kbit_s": round(per_viewer_kbit_s, 1),
    }


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    ap = argparse.ArgumentParser(description="Lightweight fan-out benchmark runner")
    ap.add_argument("--label", type=str, default=os.environ.get("BENCH_LABEL", "local"))
    ap.add_argument("--proto", type=str, default="moq-full,moq-captions,webrtc,hls")
    ap.add_argument("--concurrency", type=str, default="1,10,100")
    ap.add_argument("--duration", type=float, default=15.0, help="Measurement window in seconds")
    ap.add_argument("--warmup", type=float, default=3.0, help="Warmup seconds before sampling")
    ap.add_argument("--out", type=Path, default=Path("/results"))
    ap.add_argument("--relay", type=str, default=os.environ.get("BENCH_RELAY", "moqt://relay:4443"))
    ap.add_argument("--mediamtx", type=str, default=os.environ.get("BENCH_MEDIAMTX", "http://mediamtx"))
    ap.add_argument("--docker-sock", type=str, default="/var/run/docker.sock")
    ap.add_argument("--mock", action="store_true", help="Run in mock mode without live Docker/servers")
    args = ap.parse_args()

    protos = [p.strip() for p in args.proto.split(",") if p.strip()]
    concurrencies = [int(c.strip()) for c in args.concurrency.split(",") if c.strip()]

    out_dir = args.out if args.out.is_dir() or args.out.suffix == "" else args.out.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{args.label}.fanout.jsonl"

    monitor = DockerMonitor(sock_path=args.docker_sock)

    print(
        f"Fan-out benchmark: {len(protos)} protocols ({', '.join(protos)}) x "
        f"{len(concurrencies)} levels ({', '.join(map(str, concurrencies))}) -> {out_file}"
    )

    results = []
    for proto in protos:
        for n in concurrencies:
            row = asyncio.run(
                measure_round(
                    proto=proto,
                    n=n,
                    monitor=monitor,
                    relay_url=args.relay,
                    mediamtx_url=args.mediamtx,
                    warmup_s=args.warmup,
                    duration_s=args.duration,
                    mock=args.mock,
                )
            )
            row["kind"] = "fanout"
            row["label"] = args.label
            row["timestamp"] = datetime.now(UTC).isoformat()
            results.append(row)

            with out_file.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")

            print(
                f"[{row['label']}] {row['proto']:12s} N={row['n']:3d} | "
                f"CPU {row['cpu_pct']:5.1f}% (1 core) | "
                f"Mem {row['mem_mib']:6.1f} MiB | "
                f"TX {row['tx_mbit_s']:7.2f} Mbit/s | "
                f"Per-viewer {row['per_viewer_kbit_s']:6.1f} kbit/s"
            )

    print(f"\nDone. Saved {len(results)} rows to {out_file}.")


if __name__ == "__main__":
    main()

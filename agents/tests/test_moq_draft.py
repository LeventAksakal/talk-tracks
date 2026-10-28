"""Every aiomoqt client is pinned to MoQT draft 18 (aiomoqt offers draft 22 first when left to choose).

aiomoqt has no Windows wheels, so ``talk_tracks.moq`` is imported here against a stub that records how the client
is built.
"""

import importlib
import re
import sys
import types
from pathlib import Path
from typing import Any, ClassVar

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "talk_tracks"


class RecordingClient:
    made: ClassVar[list[dict[str, Any]]] = []

    def __init__(self, host: str, port: int, **kwargs: Any) -> None:
        RecordingClient.made.append({"host": host, "port": port, **kwargs})


@pytest.fixture
def moq(monkeypatch: pytest.MonkeyPatch) -> Any:
    agent = types.ModuleType("aiomoqt.agent")
    for name in ("AgentSession", "FetchSpec", "PublishSpec", "StartAt", "SubscribeSpec", "TrackRef"):
        setattr(agent, name, object)
    client = types.ModuleType("aiomoqt.client")
    client.MOQTClient = RecordingClient  # type: ignore[attr-defined]
    logger = types.ModuleType("aiomoqt.utils.logger")
    logger.set_log_level = lambda level: None  # type: ignore[attr-defined]
    data = types.ModuleType("aiomoqt.messages.data")
    data.FetchObject = object  # type: ignore[attr-defined]
    fetch = types.ModuleType("aiomoqt.messages.fetch")
    fetch._is_joining = lambda fetch_type: False  # type: ignore[attr-defined]
    for name, module in {
        "aiomoqt": types.ModuleType("aiomoqt"),
        "aiomoqt.agent": agent,
        "aiomoqt.client": client,
        "aiomoqt.messages": types.ModuleType("aiomoqt.messages"),
        "aiomoqt.messages.data": data,
        "aiomoqt.messages.fetch": fetch,
        "aiomoqt.utils": types.ModuleType("aiomoqt.utils"),
        "aiomoqt.utils.logger": logger,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.delitem(sys.modules, "talk_tracks.moq", raising=False)
    RecordingClient.made.clear()
    yield importlib.import_module("talk_tracks.moq")
    sys.modules.pop("talk_tracks.moq", None)


@pytest.mark.parametrize("url", ["moqt://relay:4443", "https://relay.example:443/anon"])
def test_relay_client_offers_only_draft_18(moq: Any, url: str) -> None:
    moq.relay_client(url, token="t")
    assert moq.DRAFT == 18
    assert RecordingClient.made[-1]["supported_drafts"] == 18


def test_no_other_aiomoqt_client_is_built() -> None:
    """Every connection goes through ``moq.relay_client``, so the pin above covers them all."""
    builders = {
        path.relative_to(SRC).as_posix()
        for path in SRC.rglob("*.py")
        if re.search(r"\bMOQTClient\s*\(", path.read_text(encoding="utf-8"))
    }
    assert builders == {"moq.py"}
    assert len(re.findall(r"\bMOQTClient\s*\(", (SRC / "moq.py").read_text(encoding="utf-8"))) == 1

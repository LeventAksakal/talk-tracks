import asyncio
import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, cast

import httpx
import numpy as np
import pytest

from talk_tracks.asr.meta import SAMPLE_RATE, USD_PER_MINUTE, MetaVoiceAsrSession
from talk_tracks.contracts import CaptionLine
from talk_tracks.llm.ledger import BudgetExceededError, Prices, SpendLedger
from talk_tracks.llm.meta import MetaLlm, MetaLlmError

Handler = Callable[[httpx.Request], httpx.Response]


def reply(content: str, prompt: int = 100, completion: int = 50, finish: str = "stop") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": content}, "finish_reason": finish}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": completion},
        },
    )


def make(tmp_path: Path, handler: Handler, ceiling: float = 1.0) -> MetaLlm:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ledger = SpendLedger(tmp_path / "ledger.jsonl", ceiling)
    return MetaLlm("test-key", ledger, base_url="http://127.0.0.1:1/v1", client=client)


async def test_translate_sends_data_block_and_records_cost(tmp_path: Path) -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(req.content)
        seen["auth"] = req.headers["authorization"]
        return reply("Merhaba")

    m = make(tmp_path, handler)
    assert await m.translate("Hello", lang="tr", context=["a", "b"]) == "Merhaba"
    assert seen["body"]["model"] == "muse-spark-1.3"
    assert "<line>Hello</line>" in seen["body"]["messages"][1]["content"]
    assert seen["auth"] == "Bearer test-key"
    assert m.usage.requests == 1
    assert m.usage.cost_usd == pytest.approx(100 * 1.25e-6 + 50 * 4.25e-6, abs=1e-6)
    assert SpendLedger(tmp_path / "ledger.jsonl", 1.0).total() == pytest.approx(m.usage.cost_usd, abs=1e-6)


async def test_ledger_blocks_before_the_call(tmp_path: Path) -> None:
    calls = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return reply("x")

    m = make(tmp_path, handler, ceiling=0.0001)
    with pytest.raises(BudgetExceededError):
        await m.translate("Hello", lang="tr", context=[])
    assert calls == 0


async def test_outline_parses_schema_output(tmp_path: Path) -> None:
    payload = {
        "chapters": [{"start_line": 3, "title": "Relays", "summary": "What a relay does."}],
        "glossary": [{"term": "MOQT", "definition": "Media over QUIC Transport."}],
        "recap": "A talk about relays.",
    }
    m = make(tmp_path, lambda req: reply(json.dumps(payload)))
    lines = [CaptionLine(id=i, start_ms=i * 1000, end_ms=i * 1000 + 500, text=f"t{i}") for i in range(5)]
    draft = await m.outline(lines, None, lang="en")
    assert draft.chapters[0].start_ms == 3000 and draft.glossary[0].term == "MOQT"


async def test_retry_after_429_then_success(tmp_path: Path) -> None:
    n = 0

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal n
        n += 1
        return httpx.Response(429, headers={"retry-after": "0"}, text="slow down") if n == 1 else reply("ok")

    assert await make(tmp_path, handler).translate("a", lang="tr", context=[]) == "ok"
    assert n == 2


async def test_truncated_output_is_an_error(tmp_path: Path) -> None:
    m = make(tmp_path, lambda req: reply("{", finish="length"))
    with pytest.raises(MetaLlmError):
        await m.translate("a", lang="tr", context=[])


async def test_translate_retries_once_with_more_room_when_reasoning_hits_the_cap(tmp_path: Path) -> None:
    caps: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        caps.append(body["max_completion_tokens"])
        assert body["reasoning_effort"] == "minimal"
        return reply("", finish="length") if len(caps) == 1 else reply("Uzun satir")

    assert await make(tmp_path, handler).translate("a long line", lang="tr", context=[]) == "Uzun satir"
    assert caps[1] == caps[0] * 4


def test_key_only_goes_to_meta_and_never_contributor(tmp_path: Path) -> None:
    ledger = SpendLedger(tmp_path / "l.jsonl", 1.0)
    with pytest.raises(ValueError):
        MetaLlm("k", ledger, base_url="https://example.com/v1")
    with pytest.raises(ValueError):
        MetaLlm("k", ledger, model="muse-spark-1.3-contributor")


async def test_asr_pays_each_audio_minute_before_sending_it(tmp_path: Path) -> None:
    class Ws:
        def __init__(self) -> None:
            self.sent = 0
            self.ended = asyncio.Event()

        async def send(self, data: bytes | str) -> None:
            if isinstance(data, str):
                self.ended.set()
            else:
                self.sent += 1

        async def __aiter__(self) -> AsyncIterator[str]:
            await self.ended.wait()
            return
            yield

        async def close(self) -> None:
            pass

    ledger = SpendLedger(tmp_path / "l.jsonl", USD_PER_MINUTE * 2.5)
    ws = Ws()
    session = MetaVoiceAsrSession(cast(Any, ws), 0, ledger)
    second = np.zeros(SAMPLE_RATE, dtype=np.int16)
    await session.feed(second, 1000)
    assert ledger.total() == pytest.approx(USD_PER_MINUTE)
    for t in range(2, 121):
        await session.feed(second, t * 1000)
    assert ledger.total() == pytest.approx(USD_PER_MINUTE * 2)
    with pytest.raises(BudgetExceededError):
        await session.feed(second, 122_000)
    sent = ws.sent
    with pytest.raises(BudgetExceededError):
        await session.feed(second, 123_000)
    assert ws.sent == sent
    await session.close()


def test_prices_cost() -> None:
    assert Prices(1.0, 2.0, 0.5).cost(1_000_000, 1_000_000, 500_000) == pytest.approx(0.5 + 0.25 + 2.0)

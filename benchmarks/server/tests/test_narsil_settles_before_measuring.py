from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ir_bench.core.config import BM25Params, EngineConfig
from ir_bench.drivers.narsil import NarsilDriver


def _engine() -> EngineConfig:
    return EngineConfig(
        name="narsil", url="http://engine", run_tag="narsil", ranking="bm25", analyzer=None, language=None, tracks=("vector",)
    )


def test_narsil_finishes_its_checkpoint_inside_the_timed_build_as_other_engines_finish_their_background_work() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path.endswith("/vector-maintenance"):
            return httpx.Response(200, json={"fields": [{"building": False}]})
        return httpx.Response(200, json={"ok": True})

    driver = NarsilDriver(_engine(), BM25Params(k1=0.9, b=0.4))
    driver._client = httpx.Client(base_url="http://engine", transport=httpx.MockTransport(handler))

    driver.build_vectors("scale")

    assert calls == [
        "POST /indexes/scale/vectors/_optimize",
        "GET /indexes/scale/vector-maintenance",
        "POST /indexes/scale/_checkpoint",
    ]

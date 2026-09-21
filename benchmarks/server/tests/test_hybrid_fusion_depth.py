from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ir_bench.core.config import BM25Params, EngineConfig
from ir_bench.drivers.elasticsearch import ElasticsearchDriver


def _engine() -> EngineConfig:
    return EngineConfig(
        name="elasticsearch",
        url="http://engine",
        run_tag="elasticsearch_bm25",
        ranking="bm25",
        analyzer="english",
        language=None,
        tracks=("hybrid",),
    )


@pytest.mark.parametrize("limit", [10, 1000])
def test_elasticsearch_fuses_as_many_results_per_list_as_the_page_holds(limit: int) -> None:
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"took": 1, "hits": {"total": {"value": 0}, "hits": []}})

    driver = ElasticsearchDriver(_engine(), BM25Params(k1=0.9, b=0.4))
    driver._client = httpx.Client(base_url="http://engine", transport=httpx.MockTransport(handler))

    driver.hybrid_search("scale", "harbour light", [0.1, 0.2], limit, 64)

    fusion = bodies[0]["retriever"]["rrf"]
    assert bodies[0]["size"] == limit
    assert fusion["rank_window_size"] == limit
    assert fusion["rank_constant"] == 60

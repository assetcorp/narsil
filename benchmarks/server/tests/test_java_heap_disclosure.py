from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ir_bench.core.comparison_markdown import _run_conditions
from ir_bench.core.config import BM25Params, EngineConfig
from ir_bench.drivers._lucene import LuceneRestDriver

_SIX_GIB = 6 * 1024**3
_TEN_GIB = 10 * 1024**3


def _driver(handler) -> LuceneRestDriver:
    engine = EngineConfig(
        name="opensearch",
        url="http://engine",
        run_tag="opensearch_bm25",
        ranking="bm25",
        analyzer="english",
        language=None,
        tracks=("vector",),
    )
    driver = LuceneRestDriver(engine, BM25Params(k1=0.9, b=0.4))
    driver._client = httpx.Client(base_url="http://engine", transport=httpx.MockTransport(handler))
    return driver


def test_a_lucene_engine_records_the_java_heap_its_node_reports() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/_nodes/jvm":
            return httpx.Response(200, json={"nodes": {"n1": {"jvm": {"mem": {"heap_max_in_bytes": _SIX_GIB}}}}})
        return httpx.Response(200, json={"version": {"number": "3.8.0", "build_hash": "abc"}})

    identity = _driver(handler).build_identity()

    assert identity is not None
    assert identity["version"] == "3.8.0"
    assert identity["jvm_heap_max_bytes"] == _SIX_GIB


def test_an_engine_whose_node_reports_no_heap_still_records_its_build() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/_nodes/jvm":
            return httpx.Response(503, json={})
        return httpx.Response(200, json={"version": {"number": "3.8.0"}})

    identity = _driver(handler).build_identity()

    assert identity is not None
    assert identity["version"] == "3.8.0"
    assert identity["jvm_heap_max_bytes"] is None


def test_the_comparison_prints_each_java_heap_beside_the_memory_cap() -> None:
    comparison = {
        "environment": {"os": "Linux 6.17", "arch": "x86_64", "total_memory_bytes": 32 * 1024**3},
        "config": {"memory_cap_bytes": 20 * 1024**3, "run_depth": 1000, "k1": 0.9, "b": 0.4},
        "engines": [
            {"name": "narsil", "build_identity": {"version": "0.2.3"}},
            {"name": "elasticsearch", "build_identity": {"jvm_heap_max_bytes": _TEN_GIB}},
            {"name": "opensearch", "build_identity": {"jvm_heap_max_bytes": _SIX_GIB}},
        ],
    }

    lines = _run_conditions(comparison)

    assert "- Java heap inside that cap, as each node reports it: elasticsearch 10.7 GB, opensearch 6.4 GB" in lines


def test_the_comparison_prints_no_heap_line_for_a_run_without_a_java_engine() -> None:
    comparison = {
        "environment": {"os": "Linux 6.17", "arch": "x86_64"},
        "config": {"memory_cap_bytes": 20 * 1024**3},
        "engines": [{"name": "narsil", "build_identity": {"version": "0.2.3"}}],
    }

    assert not any("Java heap" in line for line in _run_conditions(comparison))

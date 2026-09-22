from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ir_bench.core.config import BM25Params, EngineConfig
from ir_bench.drivers.narsil import NarsilDriver


def _driver(version_body: dict) -> NarsilDriver:
    engine = EngineConfig(
        name="narsil", url="http://engine", run_tag="narsil_bm25", ranking="bm25", analyzer=None, language=None,
        tracks=("vector",),
    )
    driver = NarsilDriver(engine, BM25Params(k1=0.9, b=0.4))
    driver._client = httpx.Client(
        base_url="http://engine",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=version_body)),
    )
    return driver


def test_narsil_records_the_vector_search_path_its_server_reports() -> None:
    identity = _driver({"name": "narsil", "version": "0.2.4", "gitSha": "abc", "dirty": False, "vectorSearch": "native"}).build_identity()

    assert identity is not None
    assert identity["vector_search"] == "native"
    assert identity["version"] == "0.2.4"


def test_a_server_that_predates_the_field_records_no_vector_search_path() -> None:
    identity = _driver({"name": "narsil", "version": "0.2.3", "gitSha": "abc", "dirty": False}).build_identity()

    assert identity is not None
    assert identity["vector_search"] is None

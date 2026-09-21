from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ir_bench.core import ingest
from ir_bench.core.config import BM25Params, EngineConfig
from ir_bench.drivers import _lucene
from ir_bench.drivers._lucene import LuceneRestDriver
from ir_bench.drivers.narsil import NarsilDriver


def _engine(name: str) -> EngineConfig:
    return EngineConfig(
        name=name, url="http://engine", run_tag=name, ranking="bm25", analyzer=None, language=None, tracks=("keyword",)
    )


def test_documents_the_engine_rejected_with_429_are_sent_again_until_indexed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_lucene.time, "sleep", lambda seconds: None)
    received: list[list[str]] = []
    rejected_once: set[str] = set()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/_refresh"):
            return httpx.Response(200, json={})
        lines = [json.loads(line) for line in request.content.decode("utf-8").splitlines() if line]
        ids = [line["index"]["_id"] for line in lines[0::2]]
        received.append(ids)
        items = []
        for doc_id in ids:
            if int(doc_id) % 3 == 0 and doc_id not in rejected_once:
                rejected_once.add(doc_id)
                rejection = {"type": "es_rejected_execution_exception"}
                items.append({"index": {"_id": doc_id, "status": 429, "error": rejection}})
            else:
                items.append({"index": {"_id": doc_id, "status": 201}})
        return httpx.Response(200, json={"errors": True, "items": items})

    driver = LuceneRestDriver(_engine("elasticsearch"), BM25Params(k1=0.9, b=0.4))
    driver._client = httpx.Client(base_url="http://engine", transport=httpx.MockTransport(handler))

    result = driver.import_documents("scale", ((str(n), f"document {n}") for n in range(12)), 12, 1)

    assert result.submitted == 12
    assert result.indexed == 12
    assert received == [[str(n) for n in range(12)], ["0", "3", "6", "9"]]


def test_narsil_counts_documents_it_already_holds_when_a_dropped_batch_is_sent_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ingest.time, "sleep", lambda seconds: None)
    held: set[str] = set()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        ids = [json.loads(line)["id"] for line in request.content.decode("utf-8").splitlines() if line]
        if calls == 1:
            held.update(ids[: len(ids) // 2])
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.", request=request)
        fresh = [doc_id for doc_id in ids if doc_id not in held]
        repeats = [doc_id for doc_id in ids if doc_id in held]
        held.update(fresh)
        errors = [{"docId": doc_id, "code": "DOC_ALREADY_EXISTS", "message": "exists"} for doc_id in repeats[:3]]
        body = {"indexed": len(fresh), "failed": len(repeats), "errors": errors, "errorsTruncated": len(repeats) > 3}
        return httpx.Response(200, json=body)

    driver = NarsilDriver(_engine("narsil"), BM25Params(k1=0.9, b=0.4))
    driver._client = httpx.Client(base_url="http://engine", transport=httpx.MockTransport(handler))

    result = driver.import_documents("scale", ((str(n), f"document {n}") for n in range(20)), 20, 1)

    assert calls == 2
    assert result.submitted == 20
    assert result.indexed == 20
    assert held == {str(n) for n in range(20)}

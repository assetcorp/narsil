from __future__ import annotations

import json
import time
from typing import Iterable, Iterator

import httpx

from ..core.config import BM25Params, EngineConfig
from ..core.http_client import build_client
from ..core.types import (
    INTEGER_MS,
    EngineError,
    Hit,
    ImportResult,
    SearchResponse,
    ServerTimeSource,
    VectorDoc,
    coerce_server_ms,
)

_VECTOR_FIELD = "embedding"


def _chunked(items: Iterable, size: int) -> Iterator[list]:
    batch: list[tuple[str, str]] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def _raise(response: httpx.Response) -> None:
    if response.is_success:
        return
    raise EngineError(f"HTTP {response.status_code} from {response.request.url}: {response.text[:500]}")


class LuceneRestDriver:
    """Shared driver for the Elasticsearch/OpenSearch REST surface.

    Both engines are Lucene-backed with the same index, bulk, search, count, and
    stats endpoints, BM25 similarity, and the built-in `english` analyzer. The
    only differences are the running container and how each phrases its keyword
    setup for the report, so the concrete drivers set just the name and label.
    """

    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        self.name = engine.name
        self.run_tag = engine.run_tag
        self.keyword_setup = ""
        self.server_time = ServerTimeSource(source="response `took` field", resolution=INTEGER_MS)
        self._k1 = bm25.k1
        self._b = bm25.b
        self._analyzer = engine.analyzer or "english"
        self._client = build_client(engine.url)

    def close(self) -> None:
        self._client.close()

    def wait_until_ready(self, attempts: int = 180, delay_seconds: float = 1.0) -> None:
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                response = self._client.get("/_cluster/health", params={"wait_for_status": "yellow", "timeout": "1s"})
                if response.status_code == 200 and response.json().get("status") in ("yellow", "green"):
                    return
            except (httpx.HTTPError, ValueError) as error:
                last_error = error
            time.sleep(delay_seconds)
        raise EngineError(f"{self.name} did not become ready in time: {last_error}")

    def drop_index(self, index: str) -> None:
        response = self._client.delete(f"/{index}", params={"ignore_unavailable": "true"})
        if response.status_code not in (200, 404):
            _raise(response)

    def create_index(self, index: str) -> None:
        body = {
            "settings": {
                "index": {
                    "number_of_shards": 1,
                    "number_of_replicas": 0,
                    "similarity": {"default": {"type": "BM25", "k1": self._k1, "b": self._b}},
                }
            },
            "mappings": {"properties": {"text": {"type": "text", "analyzer": self._analyzer}}},
        }
        response = self._client.put(f"/{index}", json=body)
        _raise(response)

    def _bulk(self, index: str, sources: Iterable[tuple[str, dict]], batch_size: int) -> ImportResult:
        submitted = 0
        indexed = 0
        for batch in _chunked(sources, batch_size):
            lines: list[str] = []
            for doc_id, source in batch:
                lines.append(json.dumps({"index": {"_id": doc_id}}))
                lines.append(json.dumps(source))
            body = ("\n".join(lines) + "\n").encode("utf-8")
            response = self._client.post(
                f"/{index}/_bulk",
                content=body,
                headers={"content-type": "application/x-ndjson"},
            )
            _raise(response)
            payload = response.json()
            submitted += len(batch)
            for item in payload.get("items", []):
                outcome = item.get("index") or item.get("create") or {}
                if "error" not in outcome and int(outcome.get("status", 0)) in (200, 201):
                    indexed += 1
        refresh = self._client.post(f"/{index}/_refresh")
        _raise(refresh)
        return ImportResult(submitted=submitted, indexed=indexed)

    def import_documents(self, index: str, documents: Iterable[tuple[str, str]], batch_size: int) -> ImportResult:
        return self._bulk(index, ((doc_id, {"text": text}) for doc_id, text in documents), batch_size)

    def import_vectors(self, index: str, documents: Iterable[VectorDoc], batch_size: int) -> ImportResult:
        return self._bulk(
            index,
            ((doc.doc_id, {"text": doc.text, _VECTOR_FIELD: list(doc.vector)}) for doc in documents),
            batch_size,
        )

    def build_vectors(self, index: str) -> None:
        merge = self._client.post(f"/{index}/_forcemerge", params={"max_num_segments": "1"})
        _raise(merge)
        refresh = self._client.post(f"/{index}/_refresh")
        _raise(refresh)

    def _put_settings(self, index: str, settings: dict) -> None:
        response = self._client.put(f"/{index}/_settings", json=settings)
        _raise(response)

    def bulk_load_begin(self, index: str) -> None:
        self._put_settings(index, {"index": {"refresh_interval": "-1"}})

    def bulk_load_end(self, index: str) -> None:
        self._put_settings(index, {"index": {"refresh_interval": "1s"}})
        refresh = self._client.post(f"/{index}/_refresh")
        _raise(refresh)

    def count(self, index: str) -> int:
        response = self._client.get(f"/{index}/_count")
        _raise(response)
        return int(response.json().get("count", 0))

    def _post_search(self, index: str, body: dict, params: dict | None = None) -> SearchResponse:
        response = self._client.post(f"/{index}/_search", json=body, params=params or {})
        _raise(response)
        payload = response.json()
        hit_block = payload.get("hits", {})
        hits = [
            Hit(doc_id=str(hit["_id"]), score=float(hit["_score"]))
            for hit in hit_block.get("hits", [])
            if hit.get("_score") is not None
        ]
        total = hit_block.get("total", {})
        count = int(total.get("value", len(hits))) if isinstance(total, dict) else int(total)
        return SearchResponse(hits=hits, count=count, server_elapsed_ms=coerce_server_ms(payload.get("took")))

    def search(self, index: str, term: str, limit: int) -> SearchResponse:
        return self._post_search(index, {"query": {"match": {"text": term}}, "size": limit, "_source": False})

    def index_stats(self, index: str) -> dict | None:
        response = self._client.get(f"/{index}/_stats/store")
        _raise(response)
        raw = response.json()
        size = None
        all_block = raw.get("_all", {}).get("primaries", {}).get("store", {})
        if isinstance(all_block.get("size_in_bytes"), (int, float)):
            size = int(all_block["size_in_bytes"])
        return {"index_size_bytes": size, "raw": all_block}

    def build_identity(self) -> dict | None:
        """The engine's self-reported build, read from the cluster root. Both
        Elasticsearch and OpenSearch return the git build hash and build date here,
        so the harness records what the running binary was built from rather than a
        hand-typed image tag. A failure degrades to None instead of aborting a run."""

        try:
            response = self._client.get("/")
            if not response.is_success:
                return None
            version = response.json().get("version", {})
        except (httpx.HTTPError, ValueError):
            return None
        return {
            "version": version.get("number"),
            "build_hash": version.get("build_hash"),
            "build_date": version.get("build_date"),
            "distribution": version.get("distribution"),
            "source_endpoint": "/",
            "raw": version,
        }

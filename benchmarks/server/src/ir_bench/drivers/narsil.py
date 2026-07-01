from __future__ import annotations

import json
import time
from typing import Iterable, Iterator

import httpx

from ..core.config import BM25Params, EngineConfig
from ..core.http_client import build_client
from ..core.types import (
    BEST_CONFIG,
    EQUAL_PRECISION,
    FLOATING_MS,
    EngineError,
    Hit,
    ImportResult,
    SearchResponse,
    ServerTimeSource,
    VectorDoc,
    VectorIndexParams,
    coerce_server_ms,
)

_MEMORY_KEYS = ("estimatedMemoryBytes", "memoryBytes", "memoryEstimateBytes", "memory", "bytes")
_VECTOR_FIELD = "embedding"
_RRF_K = 60


def _raise_for_envelope(response: httpx.Response) -> None:
    if response.is_success:
        return
    detail = response.text
    try:
        payload = response.json()
        error = payload.get("error")
        if isinstance(error, dict):
            detail = f"{error.get('code')}: {error.get('message')}"
    except (json.JSONDecodeError, ValueError):
        pass
    raise EngineError(f"HTTP {response.status_code} from {response.request.url}: {detail}")


def _chunked(items: Iterable[tuple[str, str]], size: int) -> Iterator[list[tuple[str, str]]]:
    batch: list[tuple[str, str]] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


class NarsilDriver:
    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        self.name = engine.name
        self.run_tag = engine.run_tag
        self.keyword_setup = (
            f"BM25 k1={bm25.k1} b={bm25.b}; Narsil english analyzer "
            "(Porter stemmer, 70-word stop list)"
        )
        self.vector_setup = "HNSW over the shared precomputed vectors, full precision (SQ8 quantization off), cosine"
        self.hybrid_setup = "BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion"
        self.hybrid_fusion = f"RRF (k={_RRF_K})"
        self.vector_knob = "efSearch"
        self.server_time = ServerTimeSource(source="response `elapsed` field", resolution=FLOATING_MS)
        self._vector_profile = EQUAL_PRECISION
        self._k1 = bm25.k1
        self._b = bm25.b
        self._language = engine.language
        self._metric = "cosine"
        self._client = build_client(engine.url)

    def close(self) -> None:
        self._client.close()

    def wait_until_ready(self, attempts: int = 120, delay_seconds: float = 1.0) -> None:
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                response = self._client.get("/readyz")
                if response.status_code == 200:
                    return
            except httpx.HTTPError as error:
                last_error = error
            time.sleep(delay_seconds)
        raise EngineError(f"Narsil did not become ready in time: {last_error}")

    def drop_index(self, index: str) -> None:
        response = self._client.delete(f"/indexes/{index}")
        if response.status_code not in (200, 404):
            _raise_for_envelope(response)

    def create_index(self, index: str) -> None:
        config: dict[str, object] = {"schema": {"text": "string"}, "bm25": {"k1": self._k1, "b": self._b}}
        if self._language:
            config["language"] = self._language
        response = self._client.post("/indexes", json={"name": index, "config": config})
        _raise_for_envelope(response)

    def _import_docs(self, index: str, documents: Iterable[dict], batch_size: int) -> ImportResult:
        submitted = 0
        indexed = 0
        failures: list[object] = []
        for batch in _chunked(documents, batch_size):
            body = "\n".join(json.dumps(doc) for doc in batch)
            response = self._client.post(
                f"/indexes/{index}/documents/_import",
                content=body.encode("utf-8"),
                headers={"content-type": "application/x-ndjson"},
            )
            _raise_for_envelope(response)
            payload = response.json()
            submitted += len(batch)
            indexed += int(payload.get("indexed", 0))
            failures.extend(payload.get("errors") or [])
        if failures:
            raise EngineError(f"Narsil rejected {len(failures)} document(s); first error: {failures[0]}")
        return ImportResult(submitted=submitted, indexed=indexed)

    def import_documents(self, index: str, documents: Iterable[tuple[str, str]], batch_size: int) -> ImportResult:
        return self._import_docs(index, ({"id": doc_id, "text": text} for doc_id, text in documents), batch_size)

    def count(self, index: str) -> int:
        response = self._client.get(f"/indexes/{index}/count")
        _raise_for_envelope(response)
        return int(response.json().get("count", 0))

    def _post_search(self, index: str, body: dict) -> SearchResponse:
        response = self._client.post(f"/indexes/{index}/search", json=body)
        _raise_for_envelope(response)
        payload = response.json()
        hits = [Hit(doc_id=str(hit["id"]), score=float(hit["score"])) for hit in payload.get("hits", [])]
        return SearchResponse(
            hits=hits,
            count=int(payload.get("count", len(hits))),
            server_elapsed_ms=coerce_server_ms(payload.get("elapsed")),
        )

    def search(self, index: str, term: str, limit: int) -> SearchResponse:
        return self._post_search(index, {"term": term, "fields": ["text"], "limit": limit})

    def create_vector_index(self, index: str, params: VectorIndexParams) -> None:
        self._metric = params.metric
        self._vector_profile = params.profile
        if params.profile == BEST_CONFIG:
            quantization = "sq8"
            self.vector_setup = (
                "HNSW over the shared precomputed vectors, SQ8 scalar quantization with "
                "full-precision rerank, cosine"
            )
            self.hybrid_setup = (
                "BM25 (text) fused with SQ8-quantized HNSW vector search (full-precision rerank) "
                "via Reciprocal Rank Fusion"
            )
        else:
            quantization = "none"
        config: dict[str, object] = {
            "schema": {"text": "string", _VECTOR_FIELD: f"vector[{params.dims}]"},
            "bm25": {"k1": self._k1, "b": self._b},
            "vectorPromotion": {
                "threshold": 1,
                "quantization": quantization,
                "hnswConfig": {"m": params.m, "efConstruction": params.ef_construction, "metric": params.metric},
            },
        }
        if self._language:
            config["language"] = self._language
        response = self._client.post("/indexes", json={"name": index, "config": config})
        _raise_for_envelope(response)

    def import_vectors(self, index: str, documents: Iterable[VectorDoc], batch_size: int) -> ImportResult:
        return self._import_docs(
            index,
            ({"id": doc.doc_id, "text": doc.text, _VECTOR_FIELD: list(doc.vector)} for doc in documents),
            batch_size,
        )

    def build_vectors(self, index: str) -> None:
        response = self._client.post(f"/indexes/{index}/vectors/_optimize", json={"field": _VECTOR_FIELD})
        _raise_for_envelope(response)
        task_id = response.json().get("taskId")
        if task_id is not None:
            self._wait_task(str(task_id))
        self._wait_graph_ready(index)

    def _wait_task(self, task_id: str, timeout_seconds: float = 600.0) -> None:
        deadline = time.perf_counter() + timeout_seconds
        while time.perf_counter() < deadline:
            response = self._client.get(f"/tasks/{task_id}")
            _raise_for_envelope(response)
            status = response.json().get("status")
            if status == "succeeded":
                return
            if status == "failed":
                raise EngineError(f"Narsil vector task {task_id} failed")
            time.sleep(0.25)
        raise EngineError(f"Narsil vector task {task_id} did not finish within {timeout_seconds}s")

    def _wait_graph_ready(self, index: str, timeout_seconds: float = 600.0) -> None:
        deadline = time.perf_counter() + timeout_seconds
        while time.perf_counter() < deadline:
            response = self._client.get(f"/indexes/{index}/vector-maintenance")
            _raise_for_envelope(response)
            fields = response.json().get("fields", [])
            if all(not field.get("building", False) for field in fields):
                return
            time.sleep(0.25)
        raise EngineError(f"Narsil vector graph for {index} did not finish building within {timeout_seconds}s")

    def _vector_clause(self, vector: list[float], ef: int | None) -> dict:
        clause: dict[str, object] = {"field": _VECTOR_FIELD, "value": vector, "metric": self._metric}
        if ef is not None:
            clause["efSearch"] = ef
        return clause

    def vector_search(self, index: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        return self._post_search(index, {"mode": "vector", "limit": limit, "vector": self._vector_clause(vector, ef)})

    def hybrid_search(self, index: str, term: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        return self._post_search(
            index,
            {
                "mode": "hybrid",
                "term": term,
                "fields": ["text"],
                "limit": limit,
                "vector": self._vector_clause(vector, ef),
                "hybrid": {"strategy": "rrf", "k": _RRF_K},
            },
        )

    def index_stats(self, index: str) -> dict | None:
        response = self._client.get(f"/indexes/{index}/stats")
        _raise_for_envelope(response)
        raw = response.json()
        size = None
        for key in _MEMORY_KEYS:
            value = raw.get(key)
            if isinstance(value, (int, float)):
                size = int(value)
                break
        return {"index_size_bytes": size, "raw": raw}

    def build_identity(self) -> dict | None:
        """The running server's own build, read from its `/version` endpoint: the
        package version and the git commit it was built from (with a dirty-tree
        flag). Older servers without the endpoint degrade to None so a run still
        completes; the recorded image identity then carries the build."""

        try:
            response = self._client.get("/version")
            if not response.is_success:
                return None
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return None
        return {
            "version": payload.get("version"),
            "build_hash": payload.get("gitSha"),
            "build_date": payload.get("buildTime"),
            "dirty": payload.get("dirty"),
            "source_endpoint": "/version",
            "raw": payload,
        }

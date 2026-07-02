from __future__ import annotations

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

_SECONDS_TO_MS = 1000.0
_SCALAR_QUANTILE = 0.99
_SCALAR_OVERSAMPLING = 2.0
# Scalar int8 is near-lossless, so the recommended 2x rescore usually clears the recall
# target on its own; the sweep escalates the rescore oversample only if it does not.
_SCALAR_OVERSAMPLING_GRID = (2.0, 3.0, 5.0, 8.0)

_DENSE = "dense"
_SPARSE = "text"
_INDEXING_THRESHOLD = 100
_FULL_SCAN_THRESHOLD_KB = 10


def _chunked(items: Iterable[VectorDoc], size: int) -> Iterator[list[VectorDoc]]:
    batch: list[VectorDoc] = []
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


class QdrantDriver:
    """Dedicated vector database. The shared dense vectors are indexed in HNSW; the
    keyword side of hybrid is Qdrant's own BM25 sparse vectors (fastembed
    `Qdrant/bm25`) with server-side IDF, fused with the dense results by Reciprocal
    Rank Fusion through the Query API. HNSW is forced on (low full-scan threshold)
    so the comparison measures the index, not a brute-force fallback."""

    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        self.name = engine.name
        self.run_tag = engine.run_tag
        self.vector_setup = "HNSW dense vectors, distance Cosine, over the shared precomputed vectors"
        self.hybrid_setup = "Dense HNSW fused with BM25 sparse vectors (fastembed Qdrant/bm25, server IDF) via RRF"
        self.hybrid_fusion = "RRF (Query API fusion)"
        self.vector_knob = "hnsw_ef"
        self.server_time = ServerTimeSource(
            source="top-level `time` field, seconds converted to ms", resolution=FLOATING_MS
        )
        self._vector_profile = EQUAL_PRECISION
        self.rescore_oversample_grid = _SCALAR_OVERSAMPLING_GRID
        self._rescore_oversample: float | None = None
        self._sparse_model_name = "Qdrant/bm25"
        self._sparse = None
        self._client = build_client(engine.url)

    def set_rescore_oversample(self, value: float | None) -> None:
        self._rescore_oversample = value

    def close(self) -> None:
        self._client.close()

    def wait_until_ready(self, attempts: int = 180, delay_seconds: float = 1.0) -> None:
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                response = self._client.get("/readyz")
                if response.status_code == 200:
                    return
            except httpx.HTTPError as error:
                last_error = error
            time.sleep(delay_seconds)
        raise EngineError(f"Qdrant did not become ready in time: {last_error}")

    def drop_index(self, index: str) -> None:
        response = self._client.delete(f"/collections/{index}")
        if response.status_code not in (200, 404):
            _raise(response)

    def create_vector_index(self, index: str, params: VectorIndexParams) -> None:
        self._vector_profile = params.profile
        body: dict = {
            "vectors": {
                _DENSE: {
                    "size": params.dims,
                    "distance": "Cosine",
                    "hnsw_config": {
                        "m": params.m,
                        "ef_construct": params.ef_construction,
                        "full_scan_threshold": _FULL_SCAN_THRESHOLD_KB,
                    },
                }
            },
            "sparse_vectors": {_SPARSE: {"modifier": "idf"}},
            "optimizers_config": {"indexing_threshold": _INDEXING_THRESHOLD},
        }
        if params.profile == BEST_CONFIG:
            body["quantization_config"] = {
                "scalar": {"type": "int8", "quantile": _SCALAR_QUANTILE, "always_ram": True}
            }
            self.vector_setup = (
                "HNSW dense vectors with int8 scalar quantization and full-precision rescore "
                f"(oversampling {_SCALAR_OVERSAMPLING}x), distance Cosine, over the shared precomputed vectors"
            )
            self.hybrid_setup = (
                "int8-quantized dense HNSW (full-precision rescore) fused with BM25 sparse vectors "
                "(fastembed Qdrant/bm25, server IDF) via RRF"
            )
        response = self._client.put(f"/collections/{index}", json=body)
        _raise(response)

    def _search_params(self, ef: int | None) -> dict | None:
        params: dict = {}
        if ef is not None:
            params["hnsw_ef"] = ef
        if self._vector_profile == BEST_CONFIG:
            oversampling = self._rescore_oversample if self._rescore_oversample is not None else _SCALAR_OVERSAMPLING
            params["quantization"] = {"rescore": True, "oversampling": oversampling}
        return params or None

    def _sparse_model(self):
        if self._sparse is None:
            from fastembed import SparseTextEmbedding

            self._sparse = SparseTextEmbedding(model_name=self._sparse_model_name)
        return self._sparse

    def import_vectors(self, index: str, documents: Iterable[VectorDoc], batch_size: int) -> ImportResult:
        model = self._sparse_model()
        submitted = 0
        point_id = 0
        for batch in _chunked(documents, batch_size):
            sparse = list(model.embed([doc.text for doc in batch]))
            points = []
            for doc, sparse_vec in zip(batch, sparse):
                points.append(
                    {
                        "id": point_id,
                        "vector": {
                            _DENSE: list(doc.vector),
                            _SPARSE: {
                                "indices": [int(i) for i in sparse_vec.indices.tolist()],
                                "values": [float(v) for v in sparse_vec.values.tolist()],
                            },
                        },
                        "payload": {"doc_id": doc.doc_id},
                    }
                )
                point_id += 1
            response = self._client.put(
                f"/collections/{index}/points", params={"wait": "true"}, json={"points": points}
            )
            _raise(response)
            submitted += len(batch)
        return ImportResult(submitted=submitted, indexed=submitted)

    def build_vectors(self, index: str, timeout_seconds: float = 600.0) -> None:
        deadline = time.perf_counter() + timeout_seconds
        while time.perf_counter() < deadline:
            response = self._client.get(f"/collections/{index}")
            _raise(response)
            result = response.json().get("result", {})
            points = int(result.get("points_count") or 0)
            indexed = int(result.get("indexed_vectors_count") or 0)
            if result.get("status") == "green" and points > 0 and indexed >= points:
                return
            time.sleep(0.5)
        raise EngineError(f"Qdrant collection {index} did not finish indexing within {timeout_seconds}s")

    def count(self, index: str) -> int:
        response = self._client.post(f"/collections/{index}/points/count", json={"exact": True})
        _raise(response)
        return int(response.json().get("result", {}).get("count", 0))

    def _parse(self, response: httpx.Response) -> SearchResponse:
        _raise(response)
        payload = response.json()
        points = payload.get("result", {}).get("points", [])
        hits = [
            Hit(doc_id=str(point.get("payload", {}).get("doc_id")), score=float(point.get("score", 0.0)))
            for point in points
        ]
        return SearchResponse(
            hits=hits,
            count=len(hits),
            server_elapsed_ms=coerce_server_ms(payload.get("time"), _SECONDS_TO_MS),
        )

    def vector_search(self, index: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        query: dict = {
            "query": vector,
            "using": _DENSE,
            "limit": limit,
            "with_payload": ["doc_id"],
        }
        params = self._search_params(ef)
        if params is not None:
            query["params"] = params
        return self._parse(self._client.post(f"/collections/{index}/points/query", json=query))

    def hybrid_search(self, index: str, term: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        sparse_results = list(self._sparse_model().query_embed(term))
        dense_prefetch: dict = {"query": vector, "using": _DENSE, "limit": limit}
        params = self._search_params(ef)
        if params is not None:
            dense_prefetch["params"] = params
        prefetch = [dense_prefetch]
        if sparse_results and len(sparse_results[0].indices) > 0:
            sparse_vec = sparse_results[0]
            prefetch.append(
                {
                    "query": {
                        "indices": [int(i) for i in sparse_vec.indices.tolist()],
                        "values": [float(v) for v in sparse_vec.values.tolist()],
                    },
                    "using": _SPARSE,
                    "limit": limit,
                }
            )
        query = {"prefetch": prefetch, "query": {"fusion": "rrf"}, "limit": limit, "with_payload": ["doc_id"]}
        return self._parse(self._client.post(f"/collections/{index}/points/query", json=query))

    def index_stats(self, index: str) -> dict | None:
        response = self._client.get(f"/collections/{index}")
        _raise(response)
        return {"index_size_bytes": None, "raw": response.json().get("result", {})}

    def build_identity(self) -> dict | None:
        """Qdrant's root endpoint reports its version and the git commit it was
        built from (which can be null on some builds). A failure degrades to None."""

        try:
            response = self._client.get("/")
            if not response.is_success:
                return None
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return None
        return {
            "version": payload.get("version"),
            "build_hash": payload.get("commit"),
            "build_date": None,
            "source_endpoint": "/",
            "raw": payload,
        }

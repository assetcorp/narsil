from __future__ import annotations

import json
import time
from typing import Iterable, Iterator

import httpx

from ..core.config import BM25Params, EngineConfig
from ..core.types import EngineError, Hit, ImportResult, SearchResponse, VectorDoc, VectorIndexParams

_HYBRID_ALPHA = 0.5


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


def _class_name(index: str) -> str:
    parts = [part for part in index.replace("-", "_").split("_") if part]
    return "".join(part[:1].upper() + part[1:] for part in parts) or "Bench"


class WeaviateDriver:
    """Dedicated vector database. Indexes the shared dense vectors in HNSW with
    `vectorizer: none`. Hybrid combines Weaviate's own BM25 over the text property
    with the dense vector through the `hybrid` operator (rankedFusion, the
    reciprocal-rank family, alpha 0.5). Weaviate's HNSW exploration factor `ef` is
    a class-level setting, so the harness's per-query value is applied by updating
    the class config when it changes."""

    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        self.name = engine.name
        self.run_tag = engine.run_tag
        self.vector_setup = "HNSW dense vectors, distance cosine, over the shared precomputed vectors"
        self.hybrid_setup = (
            f"BM25 over text fused with dense vectors via the hybrid operator "
            f"(rankedFusion, alpha={_HYBRID_ALPHA})"
        )
        self.hybrid_fusion = f"rankedFusion (alpha={_HYBRID_ALPHA})"
        self.vector_knob = "ef"
        self._client = httpx.Client(base_url=engine.url, timeout=120.0)
        self._ef_cache: dict[str, int] = {}

    def close(self) -> None:
        self._client.close()

    def wait_until_ready(self, attempts: int = 180, delay_seconds: float = 1.0) -> None:
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                response = self._client.get("/v1/.well-known/ready")
                if response.status_code == 200:
                    return
            except httpx.HTTPError as error:
                last_error = error
            time.sleep(delay_seconds)
        raise EngineError(f"Weaviate did not become ready in time: {last_error}")

    def drop_index(self, index: str) -> None:
        response = self._client.delete(f"/v1/schema/{_class_name(index)}")
        if response.status_code not in (200, 404):
            _raise(response)

    def create_vector_index(self, index: str, params: VectorIndexParams) -> None:
        self._ef_cache.pop(_class_name(index), None)
        body = {
            "class": _class_name(index),
            "vectorizer": "none",
            "vectorIndexType": "hnsw",
            "vectorIndexConfig": {
                "distance": "cosine",
                "efConstruction": params.ef_construction,
                "maxConnections": params.m,
                "ef": -1,
            },
            "properties": [
                {"name": "docId", "dataType": ["text"], "indexSearchable": False, "indexFilterable": True},
                {"name": "text", "dataType": ["text"]},
            ],
        }
        response = self._client.post("/v1/schema", json=body)
        _raise(response)

    def import_vectors(self, index: str, documents: Iterable[VectorDoc], batch_size: int) -> ImportResult:
        klass = _class_name(index)
        submitted = 0
        indexed = 0
        for batch in _chunked(documents, batch_size):
            objects = [
                {"class": klass, "properties": {"docId": doc.doc_id, "text": doc.text}, "vector": list(doc.vector)}
                for doc in batch
            ]
            response = self._client.post("/v1/batch/objects", json={"objects": objects})
            _raise(response)
            submitted += len(batch)
            for item in response.json():
                status = item.get("result", {}).get("status")
                if status in (None, "SUCCESS"):
                    indexed += 1
                else:
                    errors = item.get("result", {}).get("errors")
                    raise EngineError(f"Weaviate rejected an object: {errors}")
        return ImportResult(submitted=submitted, indexed=indexed)

    def build_vectors(self, index: str) -> None:
        return None

    def _graphql(self, query: str) -> dict:
        response = self._client.post("/v1/graphql", json={"query": query})
        _raise(response)
        payload = response.json()
        if payload.get("errors"):
            raise EngineError(f"Weaviate GraphQL error: {payload['errors']}")
        return payload.get("data", {})

    def count(self, index: str) -> int:
        klass = _class_name(index)
        data = self._graphql(f"{{ Aggregate {{ {klass} {{ meta {{ count }} }} }} }}")
        rows = data.get("Aggregate", {}).get(klass, [])
        return int(rows[0]["meta"]["count"]) if rows else 0

    def _ensure_ef(self, klass: str, ef: int | None) -> None:
        if ef is None or self._ef_cache.get(klass) == ef:
            return
        current = self._client.get(f"/v1/schema/{klass}")
        _raise(current)
        definition = current.json()
        config = definition.get("vectorIndexConfig", {})
        config["ef"] = ef
        definition["vectorIndexConfig"] = config
        response = self._client.put(f"/v1/schema/{klass}", json=definition)
        _raise(response)
        self._ef_cache[klass] = ef

    def _parse(self, rows: list[dict], score_key: str) -> SearchResponse:
        hits: list[Hit] = []
        for row in rows:
            additional = row.get("_additional", {})
            raw = additional.get(score_key)
            score = float(raw) if raw is not None else 0.0
            if score_key == "distance":
                score = 1.0 - score
            hits.append(Hit(doc_id=str(row.get("docId")), score=score))
        return SearchResponse(hits=hits, count=len(hits), server_elapsed_ms=0.0)

    def vector_search(self, index: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        klass = _class_name(index)
        self._ensure_ef(klass, ef)
        query = (
            f"{{ Get {{ {klass}(nearVector: {{vector: {json.dumps(vector)}}}, limit: {limit}) "
            f"{{ docId _additional {{ distance }} }} }} }}"
        )
        rows = self._graphql(query).get("Get", {}).get(klass, [])
        return self._parse(rows, "distance")

    def hybrid_search(self, index: str, term: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse:
        klass = _class_name(index)
        self._ensure_ef(klass, ef)
        query = (
            f"{{ Get {{ {klass}(hybrid: {{query: {json.dumps(term)}, vector: {json.dumps(vector)}, "
            f"alpha: {_HYBRID_ALPHA}, fusionType: rankedFusion, properties: [\"text\"]}}, limit: {limit}) "
            f"{{ docId _additional {{ score }} }} }} }}"
        )
        rows = self._graphql(query).get("Get", {}).get(klass, [])
        return self._parse(rows, "score")

    def index_stats(self, index: str) -> dict | None:
        response = self._client.get(f"/v1/schema/{_class_name(index)}")
        _raise(response)
        return {"index_size_bytes": None, "raw": response.json()}

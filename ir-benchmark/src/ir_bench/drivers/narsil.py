from __future__ import annotations

import json
import time
from typing import Iterable, Iterator

import httpx

from ..core.config import BM25Params, EngineConfig
from ..core.types import EngineError, Hit, ImportResult, SearchResponse

_MEMORY_KEYS = ("estimatedMemoryBytes", "memoryBytes", "memoryEstimateBytes", "memory", "bytes")


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
        self._k1 = bm25.k1
        self._b = bm25.b
        self._language = engine.language
        self._client = httpx.Client(base_url=engine.url, timeout=120.0)

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

    def import_documents(self, index: str, documents: Iterable[tuple[str, str]], batch_size: int) -> ImportResult:
        submitted = 0
        indexed = 0
        failures: list[object] = []
        for batch in _chunked(documents, batch_size):
            body = "\n".join(json.dumps({"id": doc_id, "text": text}) for doc_id, text in batch)
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

    def count(self, index: str) -> int:
        response = self._client.get(f"/indexes/{index}/count")
        _raise_for_envelope(response)
        return int(response.json().get("count", 0))

    def search(self, index: str, term: str, limit: int) -> SearchResponse:
        response = self._client.post(
            f"/indexes/{index}/search",
            json={"term": term, "fields": ["text"], "limit": limit},
        )
        _raise_for_envelope(response)
        payload = response.json()
        hits = [Hit(doc_id=str(hit["id"]), score=float(hit["score"])) for hit in payload.get("hits", [])]
        return SearchResponse(
            hits=hits,
            count=int(payload.get("count", len(hits))),
            server_elapsed_ms=float(payload.get("elapsed", 0.0)),
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

from __future__ import annotations

import json
import os
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
    coerce_server_ms,
)

_PER_PAGE = 250


def _chunked(items: Iterable[tuple[str, str]], size: int) -> Iterator[list[tuple[str, str]]]:
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


class TypesenseDriver:
    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        self.name = engine.name
        self.run_tag = engine.run_tag
        self.keyword_setup = (
            "Native token match/proximity scoring (text_match), not BM25; "
            "english locale, Snowball stemming enabled, default typo tolerance"
        )
        self.server_time = ServerTimeSource(source="response `search_time_ms` field", resolution=INTEGER_MS)
        api_key = os.environ.get("BENCH_API_KEY", "localdev")
        self._client = build_client(engine.url, headers={"X-TYPESENSE-API-KEY": api_key})

    def close(self) -> None:
        self._client.close()

    def wait_until_ready(self, attempts: int = 120, delay_seconds: float = 1.0) -> None:
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                response = self._client.get("/health")
                if response.status_code == 200 and response.json().get("ok") is True:
                    return
            except (httpx.HTTPError, ValueError) as error:
                last_error = error
            time.sleep(delay_seconds)
        raise EngineError(f"Typesense did not become ready in time: {last_error}")

    def drop_index(self, index: str) -> None:
        response = self._client.delete(f"/collections/{index}")
        if response.status_code not in (200, 404):
            _raise(response)

    def create_index(self, index: str) -> None:
        body = {
            "name": index,
            "fields": [{"name": "text", "type": "string", "locale": "en", "stem": True}],
        }
        response = self._client.post("/collections", json=body)
        _raise(response)

    def import_documents(self, index: str, documents: Iterable[tuple[str, str]], batch_size: int) -> ImportResult:
        submitted = 0
        indexed = 0
        for batch in _chunked(documents, batch_size):
            body = "\n".join(json.dumps({"id": doc_id, "text": text}) for doc_id, text in batch)
            response = self._client.post(
                f"/collections/{index}/documents/import",
                params={"action": "create"},
                content=body.encode("utf-8"),
                headers={"content-type": "text/plain"},
            )
            _raise(response)
            submitted += len(batch)
            for line in response.text.splitlines():
                if not line.strip():
                    continue
                if json.loads(line).get("success") is True:
                    indexed += 1
        return ImportResult(submitted=submitted, indexed=indexed)

    def count(self, index: str) -> int:
        response = self._client.get(f"/collections/{index}")
        _raise(response)
        return int(response.json().get("num_documents", 0))

    def search(self, index: str, term: str, limit: int) -> SearchResponse:
        hits: list[Hit] = []
        found = 0
        page = 1
        per_page = min(_PER_PAGE, limit)
        max_pages = (limit + per_page - 1) // per_page
        server_ms: float | None = None
        while page <= max_pages and len(hits) < limit:
            response = self._client.get(
                f"/collections/{index}/documents/search",
                params={
                    "q": term,
                    "query_by": "text",
                    "per_page": per_page,
                    "page": page,
                    "sort_by": "_text_match:desc",
                    "include_fields": "id",
                },
            )
            _raise(response)
            payload = response.json()
            found = int(payload.get("found", 0))
            page_ms = coerce_server_ms(payload.get("search_time_ms"))
            if page_ms is not None:
                server_ms = page_ms if server_ms is None else server_ms + page_ms
            page_hits = payload.get("hits", [])
            if not page_hits:
                break
            for hit in page_hits:
                doc_id = str(hit.get("document", {}).get("id"))
                hits.append(Hit(doc_id=doc_id, score=float(hit.get("text_match", 0))))
            page += 1
        return SearchResponse(hits=hits[:limit], count=found, server_elapsed_ms=server_ms)

    def index_stats(self, index: str) -> dict | None:
        response = self._client.get(f"/collections/{index}")
        _raise(response)
        return {"index_size_bytes": None, "raw": response.json()}

    def build_identity(self) -> dict | None:
        """Typesense's debug endpoint reports its version but no git build hash, so
        the recorded image digest carries the commit-level identity. A failure
        degrades to None."""

        try:
            response = self._client.get("/debug")
            if not response.is_success:
                return None
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            return None
        return {
            "version": payload.get("version"),
            "build_hash": None,
            "build_date": None,
            "source_endpoint": "/debug",
            "raw": payload,
        }

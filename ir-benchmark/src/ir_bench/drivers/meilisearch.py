from __future__ import annotations

import json
import os
import time
from typing import Iterable, Iterator

import httpx

from ..core.config import BM25Params, EngineConfig
from ..core.types import EngineError, Hit, ImportResult, SearchResponse


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


class MeilisearchDriver:
    def __init__(self, engine: EngineConfig, bm25: BM25Params) -> None:
        self.name = engine.name
        self.run_tag = engine.run_tag
        self.keyword_setup = (
            "Bucket-sort ranking rules (words, typo, proximity, attribute, sort, "
            "exactness), not BM25; _rankingScore for ordering; default typo "
            "tolerance and prefix search; no stemming or stop-word removal"
        )
        api_key = os.environ.get("BENCH_API_KEY", "localdev")
        self._client = httpx.Client(
            base_url=engine.url,
            timeout=120.0,
            headers={"Authorization": f"Bearer {api_key}"},
        )

    def close(self) -> None:
        self._client.close()

    def wait_until_ready(self, attempts: int = 120, delay_seconds: float = 1.0) -> None:
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                response = self._client.get("/health")
                if response.status_code == 200 and response.json().get("status") == "available":
                    return
            except (httpx.HTTPError, ValueError) as error:
                last_error = error
            time.sleep(delay_seconds)
        raise EngineError(f"Meilisearch did not become ready in time: {last_error}")

    def _wait_task(self, task_uid: int, timeout_seconds: float = 300.0) -> dict:
        deadline = time.perf_counter() + timeout_seconds
        while time.perf_counter() < deadline:
            response = self._client.get(f"/tasks/{task_uid}")
            _raise(response)
            task = response.json()
            status = task.get("status")
            if status == "succeeded":
                return task
            if status == "failed":
                raise EngineError(f"Meilisearch task {task_uid} failed: {task.get('error')}")
            time.sleep(0.25)
        raise EngineError(f"Meilisearch task {task_uid} did not finish within {timeout_seconds}s")

    def drop_index(self, index: str) -> None:
        response = self._client.delete(f"/indexes/{index}")
        if response.status_code == 404:
            return
        _raise(response)
        task_uid = response.json().get("taskUid")
        if task_uid is not None:
            try:
                self._wait_task(int(task_uid))
            except EngineError:
                return

    def create_index(self, index: str) -> None:
        response = self._client.post("/indexes", json={"uid": index, "primaryKey": "id"})
        _raise(response)
        self._wait_task(int(response.json()["taskUid"]))
        settings = self._client.patch(
            f"/indexes/{index}/settings",
            json={"searchableAttributes": ["text"]},
        )
        _raise(settings)
        self._wait_task(int(settings.json()["taskUid"]))

    def import_documents(self, index: str, documents: Iterable[tuple[str, str]], batch_size: int) -> ImportResult:
        submitted = 0
        indexed = 0
        for batch in _chunked(documents, batch_size):
            body = "\n".join(json.dumps({"id": doc_id, "text": text}) for doc_id, text in batch)
            response = self._client.post(
                f"/indexes/{index}/documents",
                content=body.encode("utf-8"),
                headers={"content-type": "application/x-ndjson"},
            )
            _raise(response)
            task = self._wait_task(int(response.json()["taskUid"]))
            submitted += len(batch)
            details = task.get("details", {})
            indexed += int(details.get("indexedDocuments", len(batch)))
        return ImportResult(submitted=submitted, indexed=indexed)

    def count(self, index: str) -> int:
        response = self._client.get(f"/indexes/{index}/stats")
        _raise(response)
        return int(response.json().get("numberOfDocuments", 0))

    def search(self, index: str, term: str, limit: int) -> SearchResponse:
        body = {
            "q": term,
            "limit": limit,
            "attributesToRetrieve": ["id"],
            "showRankingScore": True,
        }
        response = self._client.post(f"/indexes/{index}/search", json=body)
        _raise(response)
        payload = response.json()
        hits = [
            Hit(doc_id=str(hit["id"]), score=float(hit.get("_rankingScore", 0.0)))
            for hit in payload.get("hits", [])
        ]
        count = int(payload.get("estimatedTotalHits", len(hits)))
        return SearchResponse(hits=hits, count=count, server_elapsed_ms=float(payload.get("processingTimeMs", 0.0)))

    def index_stats(self, index: str) -> dict | None:
        response = self._client.get(f"/indexes/{index}/stats")
        _raise(response)
        return {"index_size_bytes": None, "raw": response.json()}

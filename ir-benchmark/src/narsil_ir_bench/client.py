from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Iterable, Iterator

import httpx


class NarsilError(RuntimeError):
    pass


@dataclass(frozen=True)
class Hit:
    doc_id: str
    score: float


@dataclass(frozen=True)
class SearchResponse:
    hits: list[Hit]
    count: int
    server_elapsed_ms: float


@dataclass(frozen=True)
class ImportResult:
    submitted: int
    indexed: int


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
    raise NarsilError(f"HTTP {response.status_code} from {response.request.url}: {detail}")


class NarsilClient:
    def __init__(self, base_url: str, timeout_seconds: float = 120.0, api_key: str | None = None) -> None:
        headers = {"x-api-key": api_key} if api_key else None
        self._client = httpx.Client(base_url=base_url, timeout=timeout_seconds, headers=headers)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "NarsilClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def wait_until_ready(self, attempts: int = 60, delay_seconds: float = 1.0) -> None:
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                response = self._client.get("/readyz")
                if response.status_code == 200:
                    return
            except httpx.HTTPError as error:
                last_error = error
            time.sleep(delay_seconds)
        raise NarsilError(f"server did not become ready in time: {last_error}")

    def drop_index_if_exists(self, name: str) -> None:
        response = self._client.delete(f"/indexes/{name}")
        if response.status_code not in (200, 404):
            _raise_for_envelope(response)

    def create_index(self, name: str, k1: float, b: float, language: str | None) -> None:
        config: dict[str, object] = {"schema": {"text": "string"}, "bm25": {"k1": k1, "b": b}}
        if language:
            config["language"] = language
        response = self._client.post("/indexes", json={"name": name, "config": config})
        _raise_for_envelope(response)

    def import_documents(self, name: str, documents: Iterable[tuple[str, str]], batch_size: int) -> ImportResult:
        submitted = 0
        indexed = 0
        failures: list[object] = []
        for batch in _chunked(documents, batch_size):
            body = "\n".join(json.dumps({"id": doc_id, "text": text}) for doc_id, text in batch)
            response = self._client.post(
                f"/indexes/{name}/documents/_import",
                content=body.encode("utf-8"),
                headers={"content-type": "application/x-ndjson"},
            )
            _raise_for_envelope(response)
            payload = response.json()
            submitted += len(batch)
            indexed += int(payload.get("indexed", 0))
            failures.extend(payload.get("errors") or [])
        if failures:
            raise NarsilError(f"import rejected {len(failures)} document(s); first error: {failures[0]}")
        return ImportResult(submitted=submitted, indexed=indexed)

    def search(self, name: str, term: str, limit: int) -> SearchResponse:
        response = self._client.post(
            f"/indexes/{name}/search",
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

    def count(self, name: str) -> int:
        response = self._client.get(f"/indexes/{name}/count")
        _raise_for_envelope(response)
        return int(response.json().get("count", 0))

    def stats(self, name: str) -> dict:
        response = self._client.get(f"/indexes/{name}/stats")
        _raise_for_envelope(response)
        return response.json()

    def snapshot_bytes(self, name: str) -> int:
        total = 0
        with self._client.stream("GET", f"/indexes/{name}/snapshot") as response:
            if response.status_code != 200:
                response.read()
                _raise_for_envelope(response)
            for chunk in response.iter_bytes():
                total += len(chunk)
        return total


def _chunked(items: Iterable[tuple[str, str]], size: int) -> Iterator[list[tuple[str, str]]]:
    batch: list[tuple[str, str]] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch

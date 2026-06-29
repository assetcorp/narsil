from __future__ import annotations

from typing import Iterable, Protocol, runtime_checkable

from .types import ImportResult, SearchResponse


@runtime_checkable
class EngineDriver(Protocol):
    """What every search engine must provide to be benchmarked.

    A driver owns how its engine is configured for keyword retrieval (analyzer,
    ranking model, BM25 parameters). The harness only sees this neutral surface,
    so the spine treats Narsil, Elasticsearch, OpenSearch, Typesense, and
    Meilisearch identically. The harness applies one uniform run-file ordering
    rule to whatever hits come back, so a driver returns hits in the engine's own
    ranked order and never rewrites scores for the scorer.
    """

    name: str
    run_tag: str
    keyword_setup: str

    def wait_until_ready(self) -> None: ...

    def drop_index(self, index: str) -> None: ...

    def create_index(self, index: str) -> None: ...

    def import_documents(
        self, index: str, documents: Iterable[tuple[str, str]], batch_size: int
    ) -> ImportResult: ...

    def count(self, index: str) -> int: ...

    def search(self, index: str, term: str, limit: int) -> SearchResponse: ...

    def index_stats(self, index: str) -> dict | None: ...

    def close(self) -> None: ...

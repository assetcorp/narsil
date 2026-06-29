from __future__ import annotations

from typing import Iterable, Protocol, runtime_checkable

from .types import ImportResult, SearchResponse, VectorDoc, VectorIndexParams


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


@runtime_checkable
class VectorDriver(Protocol):
    """The dense-retrieval surface an engine adds to also run the vector and hybrid
    tracks. Every engine indexes the identical precomputed vectors, so the dense
    side is the controlled variable; each engine still owns its own keyword side
    for hybrid (its analyzer or BM25 sparse encoder), described in `hybrid_setup`.

    `vector_search` and `hybrid_search` take a per-query search-time exploration
    value (`ef`); the harness sweeps it to a matched recall operating point and
    then measures latency there. A driver returns hits in its own ranked order;
    the harness applies the same run-file ordering rule it uses for keyword.

    The lifecycle methods (`wait_until_ready`, `drop_index`, `count`,
    `index_stats`, `close`) are shared with {@link EngineDriver}; a vector-only
    engine implements those plus the methods below.
    """

    name: str
    run_tag: str
    vector_setup: str
    hybrid_setup: str

    def create_vector_index(self, index: str, params: VectorIndexParams) -> None: ...

    def import_vectors(self, index: str, documents: Iterable[VectorDoc], batch_size: int) -> ImportResult: ...

    def build_vectors(self, index: str) -> None: ...

    def vector_search(self, index: str, vector: list[float], limit: int, ef: int | None) -> SearchResponse: ...

    def hybrid_search(
        self, index: str, term: str, vector: list[float], limit: int, ef: int | None
    ) -> SearchResponse: ...

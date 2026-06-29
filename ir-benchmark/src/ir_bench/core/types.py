from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

KEYWORD = "keyword"
VECTOR = "vector"
HYBRID = "hybrid"
TRACKS = (KEYWORD, VECTOR, HYBRID)


class EngineError(RuntimeError):
    """An engine driver could not complete a benchmark operation."""


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


@dataclass(frozen=True)
class VectorIndexParams:
    """Build-time vector-index settings held identical across every engine so the
    comparison isolates the index, not the build configuration."""

    dims: int
    metric: str
    m: int
    ef_construction: int


@dataclass(frozen=True)
class VectorDoc:
    """One corpus document carrying both its text (for an engine's own keyword
    side in hybrid) and the shared precomputed dense vector every engine indexes."""

    doc_id: str
    text: str
    vector: Sequence[float]

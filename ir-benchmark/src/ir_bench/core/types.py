from __future__ import annotations

from dataclasses import dataclass


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

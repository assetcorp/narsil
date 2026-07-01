from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

KEYWORD = "keyword"
VECTOR = "vector"
HYBRID = "hybrid"
TRACKS = (KEYWORD, VECTOR, HYBRID)

EQUAL_PRECISION = "equal-precision"
BEST_CONFIG = "best-config"
VECTOR_PROFILES = (EQUAL_PRECISION, BEST_CONFIG)

FLOATING_MS = "floating-millisecond"
INTEGER_MS = "integer-millisecond"
NOT_AVAILABLE = "not-available"
SERVER_TIME_RESOLUTIONS = (FLOATING_MS, INTEGER_MS, NOT_AVAILABLE)


class EngineError(RuntimeError):
    """An engine driver could not complete a benchmark operation."""


@dataclass(frozen=True)
class ServerTimeSource:
    """How an engine reports its own query time, advertised by each driver so the
    reporter can disclose the headline latency's provenance uniformly. `resolution`
    is one of SERVER_TIME_RESOLUTIONS; NOT_AVAILABLE means the engine exposes no
    server-side query time and only the client round-trip is recorded."""

    source: str
    resolution: str


SERVER_TIME_UNAVAILABLE = ServerTimeSource(source="client round-trip only", resolution=NOT_AVAILABLE)


def coerce_server_ms(value: object, scale: float = 1.0) -> float | None:
    """Turn an engine's raw server-time field into milliseconds, or None when the
    engine did not report one. A missing, non-numeric, non-finite, or negative
    value degrades to None (recorded as not-available) so a malformed field never
    crashes a run and is never mistaken for a real 0 ms. `scale` converts the
    engine's unit to milliseconds (for example 1000.0 for a value reported in
    seconds)."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    millis = float(value) * scale
    if not math.isfinite(millis) or millis < 0.0:
        return None
    return millis


@dataclass(frozen=True)
class Hit:
    doc_id: str
    score: float


@dataclass(frozen=True)
class SearchResponse:
    hits: list[Hit]
    count: int
    server_elapsed_ms: float | None


@dataclass(frozen=True)
class ImportResult:
    submitted: int
    indexed: int


@dataclass(frozen=True)
class VectorIndexParams:
    """Build-time vector-index settings. `dims`, `metric`, and the HNSW build
    parameters are held identical across every engine. `profile` selects how each
    engine stores its vectors: EQUAL_PRECISION keeps every engine at full float so
    the comparison isolates the index, while BEST_CONFIG lets each engine apply its
    own recommended production quantization, which differs by engine on purpose."""

    dims: int
    metric: str
    m: int
    ef_construction: int
    profile: str = EQUAL_PRECISION


@dataclass(frozen=True)
class VectorDoc:
    """One corpus document carrying both its text (for an engine's own keyword
    side in hybrid) and the shared precomputed dense vector every engine indexes."""

    doc_id: str
    text: str
    vector: Sequence[float]

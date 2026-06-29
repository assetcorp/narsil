from __future__ import annotations

from time import perf_counter_ns
from typing import Any, Callable

from .config import LatencyConfig
from .driver import EngineDriver


def _percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    rank = max(0, min(len(sorted_values) - 1, round(fraction * (len(sorted_values) - 1))))
    return sorted_values[rank]


def measure_latency(run_once: Callable[[Any], Any], items: list[Any], config: LatencyConfig) -> dict[str, float]:
    """Wall-clock client-side latency for one query at a time, after warmup. The
    caller supplies a closure that issues a single query, so keyword, vector, and
    hybrid tracks all measure the same way and the vector closure runs at the
    matched-recall operating point."""

    for _ in range(config.warmup):
        for item in items:
            run_once(item)

    samples_ms: list[float] = []
    for _ in range(config.repeats):
        for item in items:
            start = perf_counter_ns()
            run_once(item)
            samples_ms.append((perf_counter_ns() - start) / 1_000_000)

    samples_ms.sort()
    sample_count = len(samples_ms)
    return {
        "samples": sample_count,
        "top_k": config.top_k,
        "mean_ms": sum(samples_ms) / sample_count if sample_count else 0.0,
        "p50_ms": _percentile(samples_ms, 0.50),
        "p90_ms": _percentile(samples_ms, 0.90),
        "p95_ms": _percentile(samples_ms, 0.95),
        "p99_ms": _percentile(samples_ms, 0.99),
        "max_ms": samples_ms[-1] if samples_ms else 0.0,
    }


def measure_query_latency(
    driver: EngineDriver,
    index: str,
    queries: list[str],
    config: LatencyConfig,
) -> dict[str, float]:
    return measure_latency(lambda term: driver.search(index, term, config.top_k), queries, config)

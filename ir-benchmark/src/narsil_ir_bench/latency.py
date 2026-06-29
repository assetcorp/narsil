from __future__ import annotations

from time import perf_counter_ns

from .client import NarsilClient
from .config import LatencyConfig


def _percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    rank = max(0, min(len(sorted_values) - 1, round(fraction * (len(sorted_values) - 1))))
    return sorted_values[rank]


def measure_query_latency(
    client: NarsilClient,
    index: str,
    queries: list[str],
    config: LatencyConfig,
) -> dict[str, float]:
    for _ in range(config.warmup):
        for term in queries:
            client.search(index, term, config.top_k)

    samples_ms: list[float] = []
    for _ in range(config.repeats):
        for term in queries:
            start = perf_counter_ns()
            client.search(index, term, config.top_k)
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

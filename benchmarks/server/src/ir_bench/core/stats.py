from __future__ import annotations


def percentile(sorted_values: list[float], fraction: float) -> float:
    """Nearest-rank percentile over an already-sorted list. An empty list yields
    0.0 so a caller never divides into nothing; the rank is clamped to the valid
    index range so fraction 0.0 and 1.0 return the min and max."""

    if not sorted_values:
        return 0.0
    rank = max(0, min(len(sorted_values) - 1, round(fraction * (len(sorted_values) - 1))))
    return sorted_values[rank]


def summarize_ms(samples_ms: list[float]) -> dict[str, float]:
    """Mean and the p50/p90/p95/p99/max tail over a set of millisecond samples,
    the shared shape used for both the serial single-query latency and the
    per-request latency measured under concurrent load."""

    ordered = sorted(samples_ms)
    count = len(ordered)
    return {
        "samples": count,
        "mean_ms": sum(ordered) / count if count else 0.0,
        "p50_ms": percentile(ordered, 0.50),
        "p90_ms": percentile(ordered, 0.90),
        "p95_ms": percentile(ordered, 0.95),
        "p99_ms": percentile(ordered, 0.99),
        "max_ms": ordered[-1] if ordered else 0.0,
    }

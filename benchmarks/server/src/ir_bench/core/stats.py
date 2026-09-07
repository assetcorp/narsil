from __future__ import annotations

import math
import random

BOOTSTRAP_ITERATIONS = 10_000
BOOTSTRAP_SEED = 42
CONFIDENCE = 0.95


def percentile(sorted_values: list[float], fraction: float) -> float:
    """Nearest-rank percentile over an already-sorted list. An empty list yields
    0.0 so a caller never divides into nothing; the rank is clamped to the valid
    index range so fraction 0.0 and 1.0 return the min and max."""

    if not sorted_values:
        return 0.0
    rank = max(0, min(len(sorted_values) - 1, round(fraction * (len(sorted_values) - 1))))
    return sorted_values[rank]


def median(values: list[float]) -> float:
    ordered = sorted(values)
    count = len(ordered)
    if count == 0:
        return 0.0
    middle = count // 2
    if count % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def bootstrap_median_interval(
    samples: list[float],
    confidence: float = CONFIDENCE,
    seed: int = BOOTSTRAP_SEED,
    iterations: int = BOOTSTRAP_ITERATIONS,
) -> tuple[float, float]:
    count = len(samples)
    if count == 0:
        return 0.0, 0.0
    if count == 1:
        return samples[0], samples[0]
    generator = random.Random(seed)
    medians = sorted(
        median([samples[generator.randrange(count)] for _ in range(count)]) for _ in range(iterations)
    )
    alpha = 1.0 - confidence
    lower = math.floor(len(medians) * (alpha / 2.0))
    upper = min(len(medians) - 1, math.floor(len(medians) * (1.0 - alpha / 2.0)))
    return medians[lower], medians[upper]


def summarize_ms(samples_ms: list[float], under_load: bool = False) -> dict[str, float]:
    """Mean and the p50/p90/p95/p99/max tail over a set of millisecond samples,
    the shared shape used for both the serial single-query latency and the
    per-request latency measured under concurrent load."""

    ordered = sorted(samples_ms)
    count = len(ordered)
    summary = {
        "samples": count,
        "mean_ms": sum(ordered) / count if count else 0.0,
        "p50_ms": percentile(ordered, 0.50),
        "p90_ms": percentile(ordered, 0.90),
        "p95_ms": percentile(ordered, 0.95),
        "p99_ms": percentile(ordered, 0.99),
    }
    if under_load:
        summary["p999_ms"] = percentile(ordered, 0.999)
    summary["max_ms"] = ordered[-1] if ordered else 0.0
    return summary

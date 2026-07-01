from __future__ import annotations

from time import perf_counter_ns
from typing import Any, Callable

from .config import LatencyConfig
from .stats import summarize_ms
from .types import NOT_AVAILABLE, SERVER_TIME_UNAVAILABLE, ServerTimeSource


def _summarize(samples_ms: list[float], top_k: int) -> dict[str, float]:
    summary = summarize_ms(samples_ms)
    summary["top_k"] = top_k
    return summary


def measure_latency(
    run_once: Callable[[Any], Any],
    items: list[Any],
    config: LatencyConfig,
    server_time: ServerTimeSource = SERVER_TIME_UNAVAILABLE,
) -> dict[str, Any]:
    """Latency for one query at a time, after warmup. The caller supplies a closure
    that issues a single query and returns the engine's SearchResponse, so keyword,
    vector, and hybrid tracks all measure the same way and the vector closure runs
    at the matched-recall operating point.

    Client wall-clock and the engine's own reported query time come from the SAME
    single call per sample, so the two are directly comparable. The engine-reported
    time is the headline; the client round-trip is kept alongside. An engine that
    exposes no server-side query time records the server set as absent (distinct
    from a real 0 ms), never as zero.
    """

    for _ in range(config.warmup):
        for item in items:
            run_once(item)

    client_samples_ms: list[float] = []
    server_samples_ms: list[float] = []
    for _ in range(config.repeats):
        for item in items:
            start = perf_counter_ns()
            response = run_once(item)
            client_samples_ms.append((perf_counter_ns() - start) / 1_000_000)
            elapsed = getattr(response, "server_elapsed_ms", None)
            if isinstance(elapsed, (int, float)):
                server_samples_ms.append(float(elapsed))

    client_summary = _summarize(client_samples_ms, config.top_k)
    server_available = server_time.resolution != NOT_AVAILABLE and len(server_samples_ms) > 0
    server_summary = _summarize(server_samples_ms, config.top_k) if server_available else None

    record: dict[str, Any] = dict(client_summary)
    record["client"] = client_summary
    record["server"] = server_summary
    record["server_time_source"] = server_time.source
    record["server_time_resolution"] = server_time.resolution if server_available else NOT_AVAILABLE
    return record

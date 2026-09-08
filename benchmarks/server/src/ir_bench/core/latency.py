from __future__ import annotations

import math
from dataclasses import dataclass, field
from time import perf_counter_ns
from typing import Any, Callable, Sequence

from .config import LatencyConfig
from .stats import summarize_ms
from .types import NOT_AVAILABLE, SERVER_TIME_UNAVAILABLE, ServerTimeSource


@dataclass
class Trip:
    client_ms: list[float] = field(default_factory=list)
    server_ms: list[float] = field(default_factory=list)


def timed_trip(run_once: Callable[[Any], Any], items: Sequence[Any], on_response=None) -> Trip:
    trip = Trip()
    for index, item in enumerate(items):
        start = perf_counter_ns()
        response = run_once(item)
        trip.client_ms.append((perf_counter_ns() - start) / 1_000_000)
        elapsed = getattr(response, "server_elapsed_ms", None)
        if isinstance(elapsed, (int, float)):
            trip.server_ms.append(float(elapsed))
        if on_response is not None:
            on_response(index, response)
    return trip


def repeats_for(config: LatencyConfig, query_count: int) -> int:
    if query_count < 1:
        return config.min_repeats
    needed = math.ceil(config.sample_budget / query_count)
    return max(config.min_repeats, min(config.max_repeats, needed))


def warmup_sample(config: LatencyConfig, items: Sequence[Any]) -> list[Any]:
    return list(items[: config.warmup_queries])


def _summarize(samples_ms: list[float], top_k: int) -> dict[str, float]:
    summary = summarize_ms(samples_ms)
    summary["top_k"] = top_k
    return summary


def measure_latency(
    run_once: Callable[[Any], Any],
    items: list[Any],
    config: LatencyConfig,
    server_time: ServerTimeSource = SERVER_TIME_UNAVAILABLE,
    warmup_items: Sequence[Any] = (),
    prior_trips: Sequence[Trip] = (),
) -> dict[str, Any]:
    """Latency for one query at a time. The caller supplies a closure that issues
    a single query and returns the engine's SearchResponse, so keyword, vector,
    and hybrid tracks all measure the same way and the vector closure runs at the
    matched-recall operating point.

    Client wall-clock and the engine's own reported query time come from the SAME
    single call per sample, so the two are directly comparable. The engine-reported
    time is the headline; the client round-trip is kept alongside. An engine that
    exposes no server-side query time records the server set as absent (distinct
    from a real 0 ms), never as zero.

    `warmup_items` are sent once, unrecorded, before the timed trips. `prior_trips`
    are timed trips the caller already made over the same items at the same
    operating point, which count towards the trip budget so a confirmation pass
    is never repeated for its timings alone.
    """

    for item in warmup_items:
        run_once(item)

    repeats = repeats_for(config, len(items))
    trips = list(prior_trips)
    while len(trips) < repeats:
        trips.append(timed_trip(run_once, items))

    client_samples_ms = [sample for trip in trips for sample in trip.client_ms]
    server_samples_ms = [sample for trip in trips for sample in trip.server_ms]

    client_summary = _summarize(client_samples_ms, config.top_k)
    server_available = server_time.resolution != NOT_AVAILABLE and len(server_samples_ms) > 0
    server_summary = _summarize(server_samples_ms, config.top_k) if server_available else None

    record: dict[str, Any] = dict(client_summary)
    record["client"] = client_summary
    record["server"] = server_summary
    record["server_time_source"] = server_time.source
    record["server_time_resolution"] = server_time.resolution if server_available else NOT_AVAILABLE
    record["repeats"] = len(trips)
    record["prior_trips"] = len(prior_trips)
    record["warmup_queries"] = len(warmup_items)
    return record

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from time import perf_counter, process_time
from typing import Any, Callable

from .config import ThroughputConfig
from .stats import summarize_ms
from .types import NOT_AVAILABLE, SERVER_TIME_UNAVAILABLE, ServerTimeSource

_CPU_SATURATION = 0.90
_CONCURRENCY_SHORTFALL = 0.80


class _WorkerResult:
    __slots__ = ("completed", "errors", "client_ms", "server_ms")

    def __init__(self) -> None:
        self.completed = 0
        self.errors = 0
        self.client_ms: list[float] = []
        self.server_ms: list[float] = []


def _drive(
    run_once: Callable[[Any], Any],
    items: list[Any],
    worker_id: int,
    deadline: float,
    collect: bool,
    capture_server: bool,
) -> _WorkerResult:
    """One closed-loop worker. It sweeps the whole query set in order from an offset
    unique to its id, so workers start on different queries yet each still cycles
    through every one, issuing the next request the instant the previous returns
    until the window closes. A request still in flight when the window closes is
    dropped rather than counted, so a slow tail cannot inflate throughput. Every
    call is guarded, so one failing request increments the error count instead of
    killing the worker."""

    result = _WorkerResult()
    count = len(items)
    index = worker_id % count
    while perf_counter() < deadline:
        item = items[index]
        index += 1
        if index >= count:
            index = 0
        start = perf_counter()
        try:
            response = run_once(item)
            ok = True
        except Exception:
            response = None
            ok = False
        end = perf_counter()
        if end > deadline:
            break
        if not ok:
            result.errors += 1
            continue
        result.completed += 1
        if collect:
            result.client_ms.append((end - start) * 1000.0)
            if capture_server:
                elapsed = getattr(response, "server_elapsed_ms", None)
                if isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool):
                    result.server_ms.append(float(elapsed))
    return result


def _run_phase(
    run_once: Callable[[Any], Any],
    items: list[Any],
    concurrency: int,
    seconds: float,
    collect: bool,
    capture_server: bool,
) -> tuple[list[_WorkerResult], float, float]:
    """Run `concurrency` closed-loop workers for `seconds`, returning their results
    with the wall-clock and client CPU time spent over the window. The pool is a
    context manager, so every worker thread is joined before the window's timings
    are read and no thread or connection leaks past the call."""

    started = perf_counter()
    cpu_started = process_time()
    deadline = started + seconds
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [
            pool.submit(_drive, run_once, items, worker_id, deadline, collect, capture_server)
            for worker_id in range(concurrency)
        ]
        results: list[_WorkerResult] = []
        for future in futures:
            try:
                results.append(future.result())
            except Exception:
                continue
    elapsed = perf_counter() - started
    cpu_seconds = max(0.0, process_time() - cpu_started)
    return results, elapsed, cpu_seconds


def _level_record(
    results: list[_WorkerResult],
    elapsed: float,
    cpu_seconds: float,
    concurrency: int,
    capture_server: bool,
) -> dict[str, Any]:
    completed = sum(r.completed for r in results)
    errors = sum(r.errors for r in results)
    client_ms: list[float] = []
    server_ms: list[float] = []
    for r in results:
        client_ms.extend(r.client_ms)
        server_ms.extend(r.server_ms)

    qps = completed / elapsed if elapsed > 0 else 0.0
    attempted = completed + errors
    error_rate = errors / attempted if attempted else 0.0
    client_summary = summarize_ms(client_ms)
    mean_latency_s = client_summary["mean_ms"] / 1000.0
    achieved_concurrency = qps * mean_latency_s

    logical_cpus = os.cpu_count() or 1
    cores_busy = cpu_seconds / elapsed if elapsed > 0 else 0.0
    busy_fraction = cores_busy / logical_cpus if logical_cpus else 0.0
    short_of_target = achieved_concurrency < _CONCURRENCY_SHORTFALL * concurrency
    client_bound = busy_fraction >= _CPU_SATURATION or short_of_target

    return {
        "concurrency": concurrency,
        "qps": qps,
        "completed": completed,
        "errors": errors,
        "error_rate": error_rate,
        "elapsed_seconds": elapsed,
        "client_latency_ms": client_summary,
        "server_latency_ms": summarize_ms(server_ms) if (capture_server and server_ms) else None,
        "achieved_concurrency": achieved_concurrency,
        "client_cpu_seconds": cpu_seconds,
        "client_cores_busy": cores_busy,
        "client_busy_fraction": busy_fraction,
        "logical_cpus": logical_cpus,
        "client_bound": client_bound,
    }


def measure_throughput(
    run_once: Callable[[Any], Any],
    items: list[Any],
    config: ThroughputConfig,
    server_time: ServerTimeSource = SERVER_TIME_UNAVAILABLE,
) -> dict[str, Any] | None:
    """Sustained queries per second under concurrent load, the capacity metric that
    stays meaningful where single-query latency floors to sub-millisecond. The caller
    supplies the same per-query closure the latency measurement uses, so throughput
    runs at the identical matched-recall operating point for keyword, vector, and
    hybrid alike.

    Each concurrency level runs a discarded warmup window followed by a measured
    window of closed-loop workers. The headline is wall-clock QPS (completed queries
    over elapsed time); per-request latency under load is reported separately, never
    folded into the throughput number. The record also carries a client-saturation
    read (client CPU against the host's cores, and achieved versus target
    concurrency) so a reader can tell whether the engine or the harness limited the
    measured rate."""

    if not config.enabled or not items:
        return None

    capture_server = server_time.resolution != NOT_AVAILABLE
    levels: list[dict[str, Any]] = []
    for concurrency in config.concurrency:
        if config.warmup_seconds > 0:
            _run_phase(run_once, items, concurrency, config.warmup_seconds, collect=False, capture_server=False)
        results, elapsed, cpu_seconds = _run_phase(
            run_once, items, concurrency, config.duration_seconds, collect=True, capture_server=capture_server
        )
        levels.append(_level_record(results, elapsed, cpu_seconds, concurrency, capture_server))

    return {
        "warmup_seconds": config.warmup_seconds,
        "duration_seconds": config.duration_seconds,
        "server_time_source": server_time.source,
        "server_time_resolution": server_time.resolution if capture_server else NOT_AVAILABLE,
        "levels": levels,
    }

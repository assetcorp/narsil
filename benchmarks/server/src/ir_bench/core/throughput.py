from __future__ import annotations

import multiprocessing as mp
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from queue import Empty
from threading import BrokenBarrierError
from time import perf_counter, process_time
from typing import Any, Callable

from .config import ThroughputConfig
from .stats import summarize_ms
from .throughput_workload import Workload, open_driver, request_caller
from .types import NOT_AVAILABLE, SERVER_TIME_UNAVAILABLE, EngineError, ServerTimeSource

_CPU_SATURATION = 0.90
_CONCURRENCY_SHORTFALL = 0.80
_SETUP_TIMEOUT_SECONDS = 300.0
_COLLECT_SLACK_SECONDS = 120.0


class _ThreadResult:
    __slots__ = ("completed", "errors", "client_ms", "server_ms")

    def __init__(self) -> None:
        self.completed = 0
        self.errors = 0
        self.client_ms: list[float] = []
        self.server_ms: list[float] = []


@dataclass
class _ProcessResult:
    """What one load-generator process reports for the measured window: the work it
    completed, the wall-clock and CPU time it spent doing so, and the per-request
    latencies it collected. Summing CPU across processes is what makes the
    client-saturation read meaningful, because one process stays capped near a
    single core by the interpreter lock however many threads it runs."""

    completed: int = 0
    errors: int = 0
    cpu_seconds: float = 0.0
    elapsed_seconds: float = 0.0
    client_ms: list[float] = field(default_factory=list)
    server_ms: list[float] = field(default_factory=list)


def _drive(
    run_once: Callable[[Any], Any],
    items: list[Any],
    worker_id: int,
    deadline: float,
    collect: bool,
    capture_server: bool,
) -> _ThreadResult:
    """One closed-loop worker. It sweeps the whole query set in order from an offset
    unique to its id, so workers start on different queries yet each still cycles
    through every one, issuing the next request the instant the previous returns
    until the window closes. A request still in flight when the window closes is
    dropped rather than counted, so a slow tail cannot inflate throughput. Every
    call is guarded, so one failing request increments the error count instead of
    killing the worker."""

    result = _ThreadResult()
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


def _drive_window(
    run_once: Callable[[Any], Any],
    items: list[Any],
    offset: int,
    threads: int,
    seconds: float,
    collect: bool,
    capture_server: bool,
) -> list[_ThreadResult]:
    """This process's share of the closed loop for one window. Its threads spend
    nearly all their time waiting on a socket, so they overlap in-flight requests
    without competing for the interpreter lock; the parent adds processes to lift the
    lock's ceiling on the request-building and response-parsing work between them."""

    deadline = perf_counter() + seconds
    with ThreadPoolExecutor(max_workers=threads) as pool:
        futures = [
            pool.submit(_drive, run_once, items, offset + index, deadline, collect, capture_server)
            for index in range(threads)
        ]
        results: list[_ThreadResult] = []
        for future in futures:
            try:
                results.append(future.result())
            except Exception:
                continue
    return results


def _worker(
    workload: Workload,
    items: list[Any],
    offset: int,
    threads: int,
    warmup_seconds: float,
    duration_seconds: float,
    capture_server: bool,
    barrier,
    outbox,
) -> None:
    """One load-generator process. It builds its own driver, warms its connections
    and whatever the driver loads lazily on the client side, then waits at the
    barrier so every process opens its measured window together. A failure aborts the
    barrier, which frees the parent to report it rather than wait out the timeout."""

    driver = None
    try:
        driver = open_driver(workload)
        run_once = request_caller(driver, workload)
        if warmup_seconds > 0:
            _drive_window(run_once, items, offset, threads, warmup_seconds, False, False)
        barrier.wait(timeout=_SETUP_TIMEOUT_SECONDS)
        cpu_started = process_time()
        started = perf_counter()
        window = _drive_window(run_once, items, offset, threads, duration_seconds, True, capture_server)
        elapsed = perf_counter() - started
        merged = _ProcessResult(cpu_seconds=max(0.0, process_time() - cpu_started), elapsed_seconds=elapsed)
        for thread_result in window:
            merged.completed += thread_result.completed
            merged.errors += thread_result.errors
            merged.client_ms.extend(thread_result.client_ms)
            merged.server_ms.extend(thread_result.server_ms)
        outbox.put(merged)
    except BaseException:
        try:
            barrier.abort()
        except Exception:
            pass
        outbox.put(None)
    finally:
        if driver is not None:
            try:
                driver.close()
            except Exception:
                pass


def _split_workers(concurrency: int, processes: int) -> list[int]:
    """How many in-flight requests each process drives. `concurrency` keeps its
    meaning as the total load offered, so a level measured across processes stays
    comparable with the same level measured in one process."""

    count = max(1, min(processes, concurrency))
    base, extra = divmod(concurrency, count)
    return [base + (1 if index < extra else 0) for index in range(count)]


def _run_phase(
    workload: Workload,
    items: list[Any],
    concurrency: int,
    processes: int,
    warmup_seconds: float,
    duration_seconds: float,
    capture_server: bool,
) -> list[_ProcessResult]:
    """Starts the load generator, releases every process into the measured window at
    once, and collects what each reports. Warmup runs inside the processes that take
    the measurement, so the measured window opens on connections the engine has
    already accepted instead of on a fresh handshake per worker.

    The setup timeout has to cover everything a worker does before it reaches the
    barrier: spawning, importing, building its driver, loading whatever that driver
    embeds on the client side, and running the whole warmup window."""

    shares = _split_workers(concurrency, processes)
    context = mp.get_context("spawn")
    barrier = context.Barrier(len(shares) + 1)
    outbox: Any = context.Queue()
    workers = []
    offset = 0
    for threads in shares:
        workers.append(
            context.Process(
                target=_worker,
                args=(
                    workload,
                    items,
                    offset,
                    threads,
                    warmup_seconds,
                    duration_seconds,
                    capture_server,
                    barrier,
                    outbox,
                ),
                daemon=True,
            )
        )
        offset += threads

    collected: list[_ProcessResult] = []
    try:
        for worker in workers:
            worker.start()
        try:
            barrier.wait(timeout=_SETUP_TIMEOUT_SECONDS)
        except BrokenBarrierError as exc:
            raise EngineError(
                "the load generator could not start: a worker process failed before the measured window opened"
            ) from exc
        for _ in workers:
            try:
                reported = outbox.get(timeout=duration_seconds + _COLLECT_SLACK_SECONDS)
            except Empty as exc:
                raise EngineError("a load-generator process stopped reporting before its window closed") from exc
            if reported is None:
                raise EngineError("a load-generator process failed during the measured window")
            collected.append(reported)
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
            worker.join(timeout=30.0)
        outbox.close()
        outbox.join_thread()

    return collected


def _level_record(
    results: list[_ProcessResult],
    concurrency: int,
    processes: int,
    capture_server: bool,
) -> dict[str, Any]:
    completed = sum(r.completed for r in results)
    errors = sum(r.errors for r in results)
    elapsed = max((r.elapsed_seconds for r in results), default=0.0)
    cpu_seconds = sum(r.cpu_seconds for r in results)
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
    running = len(results) or processes
    ceiling_cores = float(min(running, logical_cpus))
    cores_busy = cpu_seconds / elapsed if elapsed > 0 else 0.0
    busy_fraction = cores_busy / ceiling_cores if ceiling_cores else 0.0
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
        "client_processes": running,
        "client_cpu_seconds": cpu_seconds,
        "client_cores_busy": cores_busy,
        "client_cpu_ceiling_cores": ceiling_cores,
        "client_busy_fraction": busy_fraction,
        "logical_cpus": logical_cpus,
        "client_bound": client_bound,
    }


def measure_throughput(
    workload: Workload,
    items: list[Any],
    config: ThroughputConfig,
    server_time: ServerTimeSource = SERVER_TIME_UNAVAILABLE,
) -> dict[str, Any] | None:
    """Sustained queries per second under concurrent load, the capacity metric that
    stays meaningful where single-query latency floors to sub-millisecond. The caller
    supplies the same workload the latency measurement builds its call from, so
    throughput runs at the identical matched-recall operating point for keyword,
    vector, and hybrid alike.

    The load runs across processes rather than threads alone. Building a request and
    parsing its response is interpreter work, so a single-process client saturates
    near one core and holds every engine it measures to that core divided by the
    per-request cost, whatever the engine could serve. Splitting the same offered
    concurrency across processes lifts that ceiling, at the price of client CPU the
    engine no longer has when the two share a machine, so the level record carries
    both the process count and the CPU the client spent.

    Each concurrency level runs a discarded warmup window followed by a measured
    window of closed-loop workers. The headline is wall-clock QPS (completed queries
    over elapsed time); per-request latency under load is reported separately, never
    folded into the throughput number. The record also carries a client-saturation
    read (client CPU against the cores the client's own processes can reach, and
    achieved versus target concurrency) so a reader can tell whether the engine or
    the harness limited the measured rate."""

    if not config.enabled or not items:
        return None

    capture_server = server_time.resolution != NOT_AVAILABLE
    levels: list[dict[str, Any]] = []
    for concurrency in config.concurrency:
        results = _run_phase(
            workload,
            items,
            concurrency,
            config.client_processes,
            config.warmup_seconds,
            config.duration_seconds,
            capture_server,
        )
        levels.append(_level_record(results, concurrency, config.client_processes, capture_server))

    return {
        "warmup_seconds": config.warmup_seconds,
        "duration_seconds": config.duration_seconds,
        "client_processes": config.client_processes,
        "server_time_source": server_time.source,
        "server_time_resolution": server_time.resolution if capture_server else NOT_AVAILABLE,
        "levels": levels,
    }

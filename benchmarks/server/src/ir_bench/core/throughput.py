from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable

from .config_throughput import ThroughputConfig
from .stats import bootstrap_median_interval, median, summarize_ms
from .throughput_process import CpuCounter, PhaseOutcome, ProcessResult, pack_items, run_phase
from .throughput_workload import Workload
from .types import NOT_AVAILABLE, SERVER_TIME_UNAVAILABLE, ServerTimeSource

CPU_SATURATION = 0.90
CONCURRENCY_SHORTFALL = 0.80

PhaseRunner = Callable[[Workload, Any, int, int, float, float, bool, CpuCounter | None], PhaseOutcome]


@dataclass(frozen=True)
class PassSamples:
    record: dict[str, Any]
    client_ms: list[float]
    server_ms: list[float]


def _pass_record(
    results: list[ProcessResult],
    concurrency: int,
    processes: int,
    capture_server: bool,
    engine_cores_busy: float | None = None,
) -> PassSamples:
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
    client_summary = summarize_ms(client_ms, under_load=True)
    mean_latency_s = client_summary["mean_ms"] / 1000.0
    achieved_concurrency = qps * mean_latency_s

    logical_cpus = os.cpu_count() or 1
    running = len(results) or processes
    ceiling_cores = float(min(running, logical_cpus))
    cores_busy = cpu_seconds / elapsed if elapsed > 0 else 0.0
    busy_fraction = cores_busy / ceiling_cores if ceiling_cores else 0.0
    short_of_target = achieved_concurrency < CONCURRENCY_SHORTFALL * concurrency
    client_bound = busy_fraction >= CPU_SATURATION or short_of_target

    record = {
        "concurrency": concurrency,
        "qps": qps,
        "completed": completed,
        "errors": errors,
        "error_rate": error_rate,
        "elapsed_seconds": elapsed,
        "client_latency_ms": client_summary,
        "server_latency_ms": summarize_ms(server_ms, under_load=True) if (capture_server and server_ms) else None,
        "achieved_concurrency": achieved_concurrency,
        "client_processes": running,
        "client_cpu_seconds": cpu_seconds,
        "client_cores_busy": cores_busy,
        "client_cpu_ceiling_cores": ceiling_cores,
        "client_busy_fraction": busy_fraction,
        "logical_cpus": logical_cpus,
        "client_bound": client_bound,
        "engine_cores_busy": engine_cores_busy,
    }
    return PassSamples(record=record, client_ms=client_ms, server_ms=server_ms)


def _level_record(passes: list[PassSamples], concurrency: int, cores_allowed: int | None) -> dict[str, Any]:
    records = [p.record for p in passes]
    qps_samples = [float(r["qps"]) for r in records]
    ci_low, ci_high = bootstrap_median_interval(qps_samples)
    client_ms = [sample for p in passes for sample in p.client_ms]
    server_ms = [sample for p in passes for sample in p.server_ms]
    capture_server = any(r["server_latency_ms"] is not None for r in records)
    engine_cores = [r["engine_cores_busy"] for r in records if r["engine_cores_busy"] is not None]
    bound_votes = sum(1 for r in records if r["client_bound"])
    first = records[0]
    return {
        "concurrency": concurrency,
        "qps": median(qps_samples),
        "qps_ci_low": ci_low,
        "qps_ci_high": ci_high,
        "qps_samples": qps_samples,
        "pass_count": len(records),
        "completed": sum(int(r["completed"]) for r in records),
        "errors": sum(int(r["errors"]) for r in records),
        "error_rate": median([float(r["error_rate"]) for r in records]),
        "elapsed_seconds": sum(float(r["elapsed_seconds"]) for r in records),
        "client_latency_ms": summarize_ms(client_ms, under_load=True),
        "server_latency_ms": summarize_ms(server_ms, under_load=True) if (capture_server and server_ms) else None,
        "achieved_concurrency": median([float(r["achieved_concurrency"]) for r in records]),
        "client_processes": first["client_processes"],
        "client_cpu_seconds": sum(float(r["client_cpu_seconds"]) for r in records),
        "client_cores_busy": median([float(r["client_cores_busy"]) for r in records]),
        "client_cpu_ceiling_cores": first["client_cpu_ceiling_cores"],
        "client_busy_fraction": median([float(r["client_busy_fraction"]) for r in records]),
        "logical_cpus": first["logical_cpus"],
        "client_bound": bound_votes * 2 >= len(records),
        "engine_cores_busy": median(engine_cores) if engine_cores else None,
        "engine_cores_allowed": cores_allowed,
        "passes": records,
    }


def measure_throughput(
    workload: Workload,
    items: list[Any],
    config: ThroughputConfig,
    server_time: ServerTimeSource = SERVER_TIME_UNAVAILABLE,
    engine_cpu: CpuCounter | None = None,
    run_phase: PhaseRunner = run_phase,
) -> dict[str, Any] | None:
    """Sustained queries per second under concurrent load, the capacity metric that
    stays meaningful where single-query latency floors to sub-millisecond. The caller
    supplies the same workload the latency measurement builds its call from, so
    throughput runs at the identical matched-recall operating point for keyword,
    vector, and hybrid alike.

    The load generator spreads its threads across processes. Building a request and
    parsing its response is interpreter work, so a single-process client saturates
    near one core and holds every engine it measures to that core divided by the
    per-request cost, whatever the engine could serve. Splitting the same offered
    concurrency across processes lifts that ceiling, at the price of client CPU the
    engine no longer has when the two share a machine, so the level record carries
    both the process count and the CPU the client spent.

    The measurement makes one pass at every concurrency level, then repeats the
    level with the highest QPS until it holds `passes`, so the interval is measured
    where the tables report it and the other levels cost one window each. Each pass
    starts with a discarded warmup window followed by a measured window of
    closed-loop workers. For each level the record holds the median wall-clock QPS
    across its passes with a bootstrap interval, the pooled per-request latency of
    every pass, and each pass whole. The
    record also carries a client-saturation read (client CPU against the cores the
    client's own processes can reach, and achieved versus target concurrency) so a
    reader can tell whether the engine or the harness limited the measured rate. Where
    the caller supplies a cgroup counter, the record carries the engine container's
    busy cores as well."""

    if not config.enabled or not items:
        return None

    capture_server = server_time.resolution != NOT_AVAILABLE
    cores_allowed = os.cpu_count()
    packed = pack_items(items)

    def one_pass(concurrency: int) -> PassSamples:
        outcome = run_phase(
            workload,
            packed,
            concurrency,
            config.client_processes,
            config.warmup_seconds,
            config.duration_seconds,
            capture_server,
            engine_cpu,
        )
        return _pass_record(
            outcome.results, concurrency, config.client_processes, capture_server, outcome.engine_cores_busy
        )

    passes_by_level: dict[int, list[PassSamples]] = {level: [one_pass(level)] for level in config.concurrency}
    peak = max(passes_by_level, key=lambda level: passes_by_level[level][0].record["qps"])
    for _ in range(config.passes - 1):
        passes_by_level[peak].append(one_pass(peak))
    levels = [_level_record(passes_by_level[level], level, cores_allowed) for level in config.concurrency]

    return {
        "warmup_seconds": config.warmup_seconds,
        "duration_seconds": config.duration_seconds,
        "passes": config.passes,
        "peak_concurrency": peak,
        "client_processes": config.client_processes,
        "server_time_source": server_time.source,
        "server_time_resolution": server_time.resolution if capture_server else NOT_AVAILABLE,
        "engine_cpu": None if engine_cpu is None else engine_cpu.describe(),
        "engine_cores_allowed": cores_allowed,
        "levels": levels,
    }

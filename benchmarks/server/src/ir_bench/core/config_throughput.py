from __future__ import annotations

import os
from dataclasses import dataclass

from .http_client import POOL_CONNECTIONS

DEFAULT_CONCURRENCY_LEVELS = (1, 2, 4, 8, 16, 32, 64)
DEFAULT_PASSES = 1
DEFAULT_RECALL_SWEEP_CONCURRENCY = 16
DEFAULT_DURATION_SECONDS = 5.0
DEFAULT_WARMUP_SECONDS = 1.0


@dataclass(frozen=True)
class ThroughputConfig:
    """Sustained queries-per-second under concurrent load, measured alongside the
    serial single-query latency. `concurrency` is one or more worker counts to
    drive in turn, so a single level gives one throughput number and a list sweeps
    the saturation curve. The level used is recorded with every result. Throughput
    runs at the same matched-recall operating point as the latency comparison
    because both reuse the same per-query workload.

    `client_processes` splits that offered concurrency across operating-system
    processes. One process saturates near a single core, so a threads-only client
    caps every engine at one core divided by its per-request cost; raising this
    lifts the cap and costs the engine that much CPU when the two share a host.
    Left unset it resolves to half the host's logical cores."""

    enabled: bool
    concurrency: tuple[int, ...]
    duration_seconds: float
    warmup_seconds: float
    client_processes: int
    passes: int
    recall_sweep_concurrency: int


def _within_pool(level: int, setting: str) -> int:
    if level < 1:
        raise ValueError(f"{setting} values must be positive")
    if level > POOL_CONNECTIONS:
        raise ValueError(
            f"{setting} {level} exceeds the client connection pool of {POOL_CONNECTIONS}; "
            "lower the level or raise POOL_CONNECTIONS"
        )
    return level


def _throughput_levels(section: dict) -> tuple[int, ...]:
    levels_raw = section.get("concurrency", list(DEFAULT_CONCURRENCY_LEVELS))
    env_levels = os.environ.get("BENCH_THROUGHPUT_CONCURRENCY")
    if env_levels and env_levels.strip():
        levels_raw = [part.strip() for part in env_levels.split(",") if part.strip()]
    levels = tuple(sorted({int(value) for value in levels_raw}))
    if not levels:
        raise ValueError("throughput.concurrency must list at least one level")
    for level in levels:
        _within_pool(level, "throughput.concurrency")
    return levels


def _throughput_client_processes(section: dict) -> int:
    """How many processes drive the load. An explicit setting wins, the environment
    overrides it for a one-off run, and the fallback leaves half the host's cores to
    the engine on a run where the client and the engine share a machine."""

    configured = section.get("client_processes")
    override = os.environ.get("BENCH_THROUGHPUT_CLIENT_PROCESSES")
    if override and override.strip():
        configured = override.strip()
    if configured is None:
        return max(1, (os.cpu_count() or 2) // 2)
    processes = int(configured)
    if processes < 1:
        raise ValueError("throughput.client_processes must be positive")
    return processes


def _throughput_passes(section: dict) -> int:
    configured = section.get("passes", DEFAULT_PASSES)
    override = os.environ.get("BENCH_THROUGHPUT_PASSES")
    if override and override.strip():
        configured = override.strip()
    passes = int(configured)
    if passes < 1:
        raise ValueError("throughput.passes must be positive")
    return passes


def _recall_sweep_concurrency(section: dict) -> int:
    level = int(section.get("recall_sweep_concurrency", DEFAULT_RECALL_SWEEP_CONCURRENCY))
    return _within_pool(level, "throughput.recall_sweep_concurrency")


def load_throughput(raw: dict) -> ThroughputConfig:
    section = raw.get("throughput", {})
    enabled = bool(section.get("enabled", True))
    toggle = os.environ.get("BENCH_THROUGHPUT", "").strip().lower()
    if toggle in ("0", "off", "false", "no"):
        enabled = False
    duration = float(section.get("duration_seconds", DEFAULT_DURATION_SECONDS))
    warmup = float(section.get("warmup_seconds", DEFAULT_WARMUP_SECONDS))
    if duration <= 0:
        raise ValueError("throughput.duration_seconds must be positive")
    if warmup < 0:
        raise ValueError("throughput.warmup_seconds must not be negative")
    return ThroughputConfig(
        enabled=enabled,
        concurrency=_throughput_levels(section),
        duration_seconds=duration,
        warmup_seconds=warmup,
        client_processes=_throughput_client_processes(section),
        passes=_throughput_passes(section),
        recall_sweep_concurrency=_recall_sweep_concurrency(section),
    )

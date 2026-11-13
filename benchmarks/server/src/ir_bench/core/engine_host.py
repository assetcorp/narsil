from __future__ import annotations

import socket
import time
from collections.abc import Mapping

from .cgroup_files import remote_cgroup_files_from_env
from .stats import percentile

ROUND_TRIP_SAMPLES = 200
ROUND_TRIP_CONNECT_TIMEOUT_SECONDS = 5.0
ROUND_TRIP_METHOD = "tcp_connect"
ROUND_TRIP_NOTE = (
    "Each sample is the time from opening a TCP connection to the stats service on the engine's "
    "machine until the connection is established, which takes one network round trip. The stats "
    "service is a separate process from the engine, so the probe costs the engine nothing, and the "
    "harness takes the samples before the engine starts its tracks."
)


def _connect_once_ms(host: str, port: int) -> float:
    started = time.perf_counter()
    with socket.create_connection((host, port), timeout=ROUND_TRIP_CONNECT_TIMEOUT_SECONDS):
        return (time.perf_counter() - started) * 1000.0


def measure_round_trip(host: str, port: int, samples: int = ROUND_TRIP_SAMPLES) -> dict:
    timings = sorted(_connect_once_ms(host, port) for _ in range(samples))
    return {
        "probe_host": host,
        "probe_port": port,
        "method": ROUND_TRIP_METHOD,
        "samples": len(timings),
        "round_trip_ms": {
            "min": timings[0],
            "p50": percentile(timings, 0.5),
            "p99": percentile(timings, 0.99),
            "max": timings[-1],
        },
        "note": ROUND_TRIP_NOTE,
    }


def remote_engine_environment(environ: Mapping[str, str]) -> dict | None:
    remote = remote_cgroup_files_from_env(environ)
    if remote is None:
        return None
    host, port = remote.host_and_port()
    return {"engine_machine": remote.machine(), "network": measure_round_trip(host, port)}

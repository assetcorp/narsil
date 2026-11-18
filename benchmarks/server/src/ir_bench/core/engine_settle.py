from __future__ import annotations

import time

from .engine_cpu import cores_busy
from .throughput_process import CpuCounter

QUIET_ENGINE_CORES = 0.5
QUIET_SAMPLES_REQUIRED = 5
SETTLE_SAMPLE_SECONDS = 1.0
SETTLE_TIMEOUT_SECONDS = 300.0


def wait_for_quiet_engine(engine_cpu: CpuCounter | None, spec, label: str) -> dict | None:
    if engine_cpu is None or not getattr(spec, "large", False):
        return None
    previous_usec = engine_cpu.usage_usec()
    if previous_usec is None:
        return None
    start = previous_at = time.perf_counter()
    deadline = start + SETTLE_TIMEOUT_SECONDS
    quiet_samples = 0
    while quiet_samples < QUIET_SAMPLES_REQUIRED and previous_at < deadline:
        time.sleep(SETTLE_SAMPLE_SECONDS)
        usage_usec = engine_cpu.usage_usec()
        now = time.perf_counter()
        busy = cores_busy(previous_usec, usage_usec, now - previous_at)
        if busy is None:
            return None
        quiet_samples = quiet_samples + 1 if busy < QUIET_ENGINE_CORES else 0
        previous_usec, previous_at = usage_usec, now
    settled = quiet_samples >= QUIET_SAMPLES_REQUIRED
    waited = previous_at - start
    state = "went quiet" if settled else "stayed busy until the time limit"
    print(f"{label} engine {state} after {waited:.0f}s of waiting after the load", flush=True)
    return {
        "quiet_engine_cores": QUIET_ENGINE_CORES,
        "quiet_seconds": QUIET_SAMPLES_REQUIRED * SETTLE_SAMPLE_SECONDS,
        "timeout_seconds": SETTLE_TIMEOUT_SECONDS,
        "settled": settled,
        "waited_seconds": round(waited, 1),
    }
